import consola from "consola"
import { Hono } from "hono"
import { timingSafeEqual } from "node:crypto"

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
  gatewayKey: string
  onComplete: (summary: CompletedRequestSummary) => void
}) {
  consola.level = -999
  const app = new Hono()
  const key = Buffer.from(options.gatewayKey)
  const matchesKey = (candidate: string) => {
    const buffer = Buffer.from(candidate)
    return buffer.length === key.length && timingSafeEqual(buffer, key)
  }
  app.use(async (c, next) => {
    if (
      c.req.header("host") !== `127.0.0.1:${options.port}`
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
      (!authorization && !apiKey)
      || (authorization !== undefined && (!bearer || !matchesKey(bearer)))
      || (apiKey !== undefined && !matchesKey(apiKey))
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
  app.use(createRequestLogMiddleware(() => undefined, options.onComplete))
  app.get("/", (c) => c.json({ service: "Copilot Bridge" }))
  for (const prefix of ["", "/v1"]) {
    app.route(`${prefix}/models`, modelRoutes)
    app.route(`${prefix}/chat/completions`, completionRoutes)
    app.route(`${prefix}/responses`, responsesRoutes)
    app.route(`${prefix}/messages`, messageRoutes)
    app.route(`${prefix}/embeddings`, embeddingRoutes)
  }
  return app
}
