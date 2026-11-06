import { getRequestListener } from "@hono/node-server"
import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import { createServer, type ServerResponse } from "node:http"

import type { CompletedRequestSummary } from "../../src/lib/request-log"
import type { ModelsResponse } from "../../src/services/copilot/get-models"
import type { EngineEvent, EngineInit } from "./protocol"

import { createDesktopProxy } from "../../src/desktop-proxy"
import { initProxyFromEnv } from "../../src/lib/proxy"
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

export type DrainResult =
  | { kind: "drained" }
  | { kind: "timeout"; inFlight: number }

function safeTokenCount(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : null
}

export async function startEngine(
  init: EngineInit,
  send: (event: EngineEvent) => void,
) {
  const abort = new AbortController()
  if (init.options?.proxyFromEnvironment) initProxyFromEnv()
  const client = createAccountClient({
    githubToken: init.githubToken,
    accountType: init.accountType,
    fixtureOrigin: init.fixtureOrigin,
    signal: abort.signal,
  })
  const authentication = init.authentication ?? {
    kind: "keyed",
    keys: [init.gatewayKey ?? ""],
  }
  state.githubToken = init.githubToken
  state.accountType = init.accountType
  state.localApiKeys =
    authentication.kind === "keyed" ? authentication.keys : []
  state.manualApprove = init.options?.manualApprove ?? false
  state.rateLimitSeconds = init.options?.rateLimitSeconds ?? undefined
  state.rateLimitWait = init.options?.rateLimitWait ?? false
  state.responsesContextTrim = init.options?.responsesContextTrim ?? false
  state.lastRequestTimestamp = undefined
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

  const completions = createResponseCompletions((summary) => {
    send({
      kind: "activity",
      record: {
        ...summary,
        id: randomUUID(),
        model:
          state.models?.data.some((item) => item.id === summary.model) ?
            summary.model
          : null,
        method:
          /^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(summary.method) ?
            summary.method
          : "OTHER",
        path: safePaths.has(summary.path) ? summary.path : "/unsupported",
        inputTokens: safeTokenCount(summary.inputTokens),
        outputTokens: safeTokenCount(summary.outputTokens),
        cachedTokens: safeTokenCount(summary.cachedTokens),
      },
    })
  })
  const app = createDesktopProxy({
    port: init.port,
    authentication,
    onComplete: (summary) => completions.observe(summary),
  })
  const listener = await createNodeListener({
    fetch: app.fetch,
    port: init.port,
    onResponse: (outgoing, operation) => completions.run(outgoing, operation),
    onDraining: (inFlight) => send({ kind: "draining", inFlight }),
  })
  scheduleRefresh(initialToken.refresh_in)
  send({ kind: "ready" })
  return {
    updateModels(models: ModelsResponse): void {
      state.models = models
    },
    drain: (timeoutMs: number) => listener.drain(timeoutMs),
    resume: () => listener.resume(),
    async stop(): Promise<DrainResult> {
      const result = await listener.forceStop()
      abort.abort()
      clearTimeout(tokenTimer)
      state.githubToken = undefined
      state.copilotToken = undefined
      state.models = undefined
      state.localApiKeys = []
      return result
    },
  }
}

function createResponseCompletions(
  send: (summary: CompletedRequestSummary) => void,
) {
  interface Completion {
    summary: CompletedRequestSummary | null
    endedAt: number | null
    cancelled: boolean
    sent: boolean
  }
  const requests = new AsyncLocalStorage<Completion>()
  const finish = (completion: Completion) => {
    if (completion.sent || !completion.summary || completion.endedAt === null)
      return
    completion.sent = true
    send({
      ...completion.summary,
      outcome: completion.cancelled ? "cancelled" : completion.summary.outcome,
      durationMs: Math.max(
        0,
        completion.endedAt - Date.parse(completion.summary.startedAt),
      ),
    })
  }
  return {
    observe(summary: CompletedRequestSummary): void {
      const completion = requests.getStore()
      if (!completion) return
      completion.summary = summary
      finish(completion)
    },
    run(outgoing: ServerResponse, operation: () => void): void {
      const completion: Completion = {
        summary: null,
        endedAt: null,
        cancelled: false,
        sent: false,
      }
      const end = () => {
        completion.endedAt ??= Date.now()
        completion.cancelled = !outgoing.writableFinished
        finish(completion)
      }
      outgoing.once("finish", end)
      outgoing.once("close", end)
      requests.run(completion, operation)
    },
  }
}

export async function createNodeListener(options: {
  fetch: Parameters<typeof getRequestListener>[0]
  port: number
  onResponse?: (outgoing: ServerResponse, operation: () => void) => void
  onDraining?: (inFlight: number) => void
}) {
  const respond = getRequestListener(options.fetch)
  const inFlight = new Set<ServerResponse>()
  const waiters = new Set<() => void>()
  let accepting = true
  let closed = false
  let closing: Promise<void> | undefined
  const servers = ["127.0.0.1", "::1"].map(() =>
    createServer((incoming, outgoing) => {
      const path = new URL(incoming.url ?? "/", "http://localhost").pathname
      if (!accepting && incoming.method === "POST" && safePaths.has(path)) {
        incoming.resume()
        outgoing.writeHead(503, {
          "content-type": "application/json",
          connection: "close",
        })
        outgoing.end(
          JSON.stringify({
            error: {
              message: "The gateway is draining. Retry after it restarts.",
            },
          }),
        )
        return
      }
      inFlight.add(outgoing)
      const release = () => {
        if (!inFlight.delete(outgoing)) return
        if (!accepting) options.onDraining?.(inFlight.size)
        if (inFlight.size === 0) for (const waiter of waiters) waiter()
      }
      outgoing.once("finish", release)
      outgoing.once("close", release)
      const operation = () => {
        void Promise.resolve(respond(incoming, outgoing)).catch(() =>
          outgoing.destroy(),
        )
      }
      if (options.onResponse) options.onResponse(outgoing, operation)
      else operation()
    }),
  )
  try {
    await bindLoopbackServers(servers, options.port)
  } catch (error) {
    await closeLoopbackServers(servers, true)
    throw error
  }
  const drain = async (timeoutMs: number): Promise<DrainResult> => {
    accepting = false
    options.onDraining?.(inFlight.size)
    if (inFlight.size === 0) return { kind: "drained" }
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer)
        waiters.delete(finish)
        resolve({ kind: "drained" })
      }
      const timer = setTimeout(() => {
        waiters.delete(finish)
        resolve({ kind: "timeout", inFlight: inFlight.size })
      }, timeoutMs)
      waiters.add(finish)
      if (inFlight.size === 0) finish()
    })
  }
  return {
    drain,
    resume(): void {
      if (!closed && !closing) accepting = true
    },
    async forceStop(): Promise<DrainResult> {
      accepting = false
      closing ??= closeLoopbackServers(servers, true).then(() => {
        closed = true
      })
      await closing
      return { kind: "drained" }
    },
    async stop(timeoutMs = 15_000): Promise<DrainResult> {
      if (closed) return { kind: "drained" }
      const result = await drain(timeoutMs)
      if (result.kind === "timeout") return result
      closing ??= closeLoopbackServers(servers, false).then(() => {
        closed = true
      })
      await closing
      return { kind: "drained" }
    },
  }
}
async function bindLoopbackServers(
  servers: Array<ReturnType<typeof createServer>>,
  port: number,
): Promise<void> {
  for (const [index, server] of servers.entries()) {
    server.headersTimeout = 10_000
    server.requestTimeout = 300_000
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(
        { port, host: index === 0 ? "127.0.0.1" : "::1", ipv6Only: true },
        () => {
          server.removeListener("error", reject)
          resolve()
        },
      )
    })
  }
}
function closeLoopbackServers(
  servers: Array<ReturnType<typeof createServer>>,
  force: boolean,
): Promise<void> {
  return Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
          if (force) server.closeAllConnections()
          else server.closeIdleConnections()
        }),
    ),
  ).then(() => undefined)
}
