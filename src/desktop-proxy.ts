import consola from "consola"
import { Hono } from "hono"
import { AsyncLocalStorage } from "node:async_hooks"
import { timingSafeEqual } from "node:crypto"

import type { RuntimeOverrides } from "./lib/proxy-contracts"

import {
  type CompletedRequestSummary,
  createRequestLogMiddleware,
} from "./lib/request-log"
import { completionRoutes } from "./routes/chat-completions/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRoutes } from "./routes/models/route"
import { responsesRoutes } from "./routes/responses/route"

export function createDesktopProxy(options: {
  port: number
  gatewayKey?: string
  authentication?: NonNullable<RuntimeOverrides["authentication"]>
  onComplete: (summary: CompletedRequestSummary) => void
}) {
  consola.level = -999
  const app = new Hono()
  const authentication = options.authentication ?? {
    kind: "keyed",
    keys: [options.gatewayKey ?? ""],
  }
  if (
    authentication.kind === "keyed"
    && authentication.keys.some((key) => key.length === 0)
  )
    throw new Error("A keyed gateway requires an API key")
  const keys =
    authentication.kind === "keyed" ?
      authentication.keys.map((key) => Buffer.from(key))
    : []
  const matchesKey = (candidate: string) => {
    const buffer = Buffer.from(candidate)
    return keys.some(
      (key) => buffer.length === key.length && timingSafeEqual(buffer, key),
    )
  }
  app.use(async (c, next) => {
    if (
      ![
        `[::1]:${options.port}`,
        `127.0.0.1:${options.port}`,
        `localhost:${options.port}`,
      ].includes(c.req.header("host") ?? "")
      || c.req.raw.headers.has("origin")
    ) {
      return c.json(
        {
          error: { message: "This gateway accepts local agent requests only" },
        },
        403,
      )
    }
    const authorization = c.req.header("authorization")
    const apiKey = c.req.header("x-api-key")
    const bearer = authorization?.match(/^Bearer (\S+)$/i)?.[1]
    if (
      authentication.kind === "keyed"
      && ((!authorization && !apiKey)
        || (authorization !== undefined && (!bearer || !matchesKey(bearer)))
        || (apiKey !== undefined && !matchesKey(apiKey)))
    ) {
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
    await next()
  })
  app.use((context, next) =>
    createRequestLogMiddleware(
      () => undefined,
      AsyncLocalStorage.bind(options.onComplete),
    )(context, next),
  )
  app.get("/", (c) => c.json({ service: "Copilot Proxy" }))
  for (const prefix of ["", "/v1"]) {
    app.route(`${prefix}/models`, modelRoutes)
    app.route(`${prefix}/chat/completions`, completionRoutes)
    app.route(`${prefix}/responses`, responsesRoutes)
    app.route(`${prefix}/messages`, messageRoutes)
    app.route(`${prefix}/embeddings`, embeddingRoutes)
  }
  return app
}
