import { getRequestListener } from "@hono/node-server"
import { randomUUID } from "node:crypto"
import { createServer } from "node:http"

import type { ModelsResponse } from "../../src/services/copilot/get-models"
import type { EngineEvent, EngineInit } from "./protocol"

import { createDesktopProxy } from "../../src/desktop-proxy"
import { state } from "../../src/lib/state"
import { DEFAULT_VSCODE_VERSION } from "../../src/services/get-vscode-version"
import { createAccountClient } from "./upstream"

const safePaths = new Set([
  "/",
  "/models",
  "/v1/models",
  "/chat/completions",
  "/v1/chat/completions",
  "/responses",
  "/v1/responses",
  "/messages",
  "/v1/messages",
  "/messages/count_tokens",
  "/v1/messages/count_tokens",
  "/embeddings",
  "/v1/embeddings",
])

function safeTokenCount(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : null
}

export async function startEngine(
  init: EngineInit,
  send: (event: EngineEvent) => void,
) {
  const abort = new AbortController()
  const client = createAccountClient({
    githubToken: init.githubToken,
    accountType: init.accountType,
    fixtureOrigin: init.fixtureOrigin,
    signal: abort.signal,
  })
  state.githubToken = init.githubToken
  state.accountType = init.accountType
  state.localApiKeys = [init.gatewayKey]
  state.vsCodeVersion = DEFAULT_VSCODE_VERSION
  const initialToken = await client.token()
  state.copilotToken = initialToken.token
  state.models = await client.models(initialToken.token)

  let tokenTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleRefresh = (refreshSeconds: number) => {
    tokenTimer = setTimeout(
      () => {
        void client
          .token()
          .then((token) => {
            if (abort.signal.aborted) return
            state.copilotToken = token.token
            scheduleRefresh(token.refresh_in)
          })
          .catch(() => {
            if (!abort.signal.aborted) scheduleRefresh(90)
          })
      },
      Math.max(30, Math.min(86_400, refreshSeconds - 60)) * 1000,
    )
    tokenTimer.unref()
  }

  const app = createDesktopProxy({
    port: init.port,
    gatewayKey: init.gatewayKey,
    onComplete(summary) {
      const model =
        state.models?.data.some((item) => item.id === summary.model) ?
          summary.model
        : null
      send({
        kind: "activity",
        record: {
          ...summary,
          id: randomUUID(),
          model,
          method:
            (
              /^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(
                summary.method,
              )
            ) ?
              summary.method
            : "OTHER",
          path: safePaths.has(summary.path) ? summary.path : "/unsupported",
          inputTokens: safeTokenCount(summary.inputTokens),
          outputTokens: safeTokenCount(summary.outputTokens),
          cachedTokens: safeTokenCount(summary.cachedTokens),
        },
      })
    },
  })

  const listener = await createNodeListener({
    fetch: app.fetch,
    port: init.port,
  })
  scheduleRefresh(initialToken.refresh_in)
  send({ kind: "ready" })
  let stopping: Promise<void> | undefined
  return {
    updateModels(models: ModelsResponse): void {
      state.models = models
    },
    stop(): Promise<void> {
      stopping ??= (async () => {
        abort.abort()
        clearTimeout(tokenTimer)
        await listener.stop()
        state.githubToken = undefined
        state.copilotToken = undefined
        state.models = undefined
        state.localApiKeys = []
      })()
      return stopping
    },
  }
}

async function createNodeListener(options: {
  fetch: Parameters<typeof getRequestListener>[0]
  port: number
}) {
  const respond = getRequestListener(options.fetch)
  const inFlight = new Set<Promise<void>>()
  const server = createServer((incoming, outgoing) => {
    const response = Promise.resolve(respond(incoming, outgoing))
      .catch(() => {
        outgoing.destroy()
      })
      .finally(() => inFlight.delete(response))
    inFlight.add(response)
  })
  server.headersTimeout = 10_000
  server.requestTimeout = 300_000
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port, "127.0.0.1", () => {
      server.removeListener("error", reject)
      resolve()
    })
  })
  let stopping: Promise<void> | undefined
  return {
    stop(): Promise<void> {
      stopping ??= new Promise((resolve) => {
        const force = setTimeout(() => server.closeAllConnections(), 750)
        server.close(() => {
          clearTimeout(force)
          void Promise.race([
            Promise.allSettled(inFlight),
            new Promise<void>((complete) => setTimeout(complete, 200)),
          ]).then(() => resolve())
        })
        server.closeIdleConnections()
      })
      return stopping
    },
  }
}
