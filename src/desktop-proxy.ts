import type { Context } from "hono"

import consola from "consola"
import { Hono } from "hono"
import { AsyncLocalStorage } from "node:async_hooks"
import { timingSafeEqual } from "node:crypto"

import { isGeminiPath } from "./lib/local-auth"
import {
  type CompletedRequestSummary,
  createRequestLogMiddleware,
} from "./lib/request-log"
import { completionRoutes } from "./routes/chat-completions/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { geminiRoutes } from "./routes/gemini/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRoutes } from "./routes/models/route"
import { responsesRoutes } from "./routes/responses/route"
import { v1ModelRoutes } from "./server"

export type DesktopProxyAuthentication =
  | { kind: "none" }
  | { kind: "keyed"; keys: Array<string> }

function isLocalGatewayHost(host: string | undefined, port: number): boolean {
  return (
    host === `[::1]:${port}`
    || host === `127.0.0.1:${port}`
    || host === `localhost:${port}`
  )
}

function createKeyMatcher(keys: Array<string>): (candidate: string) => boolean {
  const keyBuffers = keys.map((key) => Buffer.from(key))
  return (candidate: string) => {
    const buffer = Buffer.from(candidate)
    return keyBuffers.some(
      (key) => buffer.length === key.length && timingSafeEqual(buffer, key),
    )
  }
}

function hasValidGatewayCredentials(options: {
  authorization: string | undefined
  apiKey: string | undefined
  googleKey: string | undefined
  geminiPath: boolean
  matchesKey: (candidate: string) => boolean
}): boolean {
  const { authorization, apiKey, googleKey, geminiPath, matchesKey } = options
  const bearer = authorization?.match(/^Bearer (\S+)$/i)?.[1]
  const acceptedCredentials = [
    authorization === undefined ? undefined : (bearer ?? ""),
    apiKey,
    geminiPath ? googleKey : undefined,
  ].filter((credential) => credential !== undefined)
  if (acceptedCredentials.length === 0) return false
  const presentedCredentials =
    geminiPath || googleKey === undefined ?
      acceptedCredentials
    : [...acceptedCredentials, googleKey]
  return presentedCredentials.every((credential) => matchesKey(credential))
}

function unauthorizedResponse(c: Context, geminiPath: boolean): Response {
  if (geminiPath) {
    return c.json(
      {
        error: {
          code: 401,
          status: "UNAUTHENTICATED",
          message: "Missing or invalid gateway key",
        },
      },
      401,
    )
  }
  return c.json(
    {
      error: {
        message: "Missing or invalid gateway key",
        type: "authentication_error",
      },
    },
    401,
  )
}

export function createDesktopProxy(options: {
  port: number
  gatewayKey?: string
  authentication?: DesktopProxyAuthentication
  onComplete: (summary: CompletedRequestSummary) => void
}) {
  consola.level = -999
  const app = new Hono()
  const authentication: DesktopProxyAuthentication = options.authentication ?? {
    kind: "keyed",
    keys: [options.gatewayKey ?? ""],
  }
  if (
    authentication.kind === "keyed"
    && (authentication.keys.length === 0
      || authentication.keys.some((key) => key.length === 0))
  ) {
    throw new Error("A keyed gateway requires an API key")
  }
  const matchesKey =
    authentication.kind === "keyed" ?
      createKeyMatcher(authentication.keys)
    : () => true

  app.use(async (c, next) => {
    if (
      !isLocalGatewayHost(c.req.header("host"), options.port)
      || c.req.raw.headers.has("origin")
    ) {
      return c.json(
        {
          error: { message: "This gateway accepts local agent requests only" },
        },
        403,
      )
    }

    if (authentication.kind === "keyed") {
      const authorization = c.req.header("authorization")
      const apiKey = c.req.header("x-api-key")
      const googleKey = c.req.header("x-goog-api-key")
      const geminiPath = isGeminiPath(c.req.path, googleKey !== undefined)
      if (
        !hasValidGatewayCredentials({
          authorization,
          apiKey,
          googleKey,
          geminiPath,
          matchesKey,
        })
      ) {
        return unauthorizedResponse(c, geminiPath)
      }
    }

    await next()
  })

  app.use((context, next) =>
    createRequestLogMiddleware(
      () => undefined,
      AsyncLocalStorage.bind(options.onComplete),
    )(context, next),
  )
  app.route("/v1beta/models", geminiRoutes)
  app.get("/", (c) => c.json({ service: "Copilot Proxy" }))
  app.route("/models", modelRoutes)
  app.route("/v1/models", v1ModelRoutes)
  for (const prefix of ["", "/v1"]) {
    app.route(`${prefix}/chat/completions`, completionRoutes)
    app.route(`${prefix}/responses`, responsesRoutes)
    app.route(`${prefix}/messages`, messageRoutes)
    app.route(`${prefix}/embeddings`, embeddingRoutes)
  }
  return app
}
