import { Hono } from "hono"
import { cors } from "hono/cors"

import { optionalLocalAuth } from "./lib/local-auth"
import { requestLogMiddleware } from "./lib/request-log"
import { requestTraceMiddleware } from "./lib/request-trace"
import { completionRoutes } from "./routes/chat-completions/route"
import { debugRoutes } from "./routes/debug/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRoutes } from "./routes/models/route"
import { responsesRoutes } from "./routes/responses/route"
import { tokenRoute } from "./routes/token/route"
import { usageRoute } from "./routes/usage/route"

export const server = new Hono()

server.use(requestLogMiddleware)
server.use(cors())
server.use(requestTraceMiddleware)

server.get("/", (c) => c.text("Server running"))

server.use(optionalLocalAuth)

server.route("/chat/completions", completionRoutes)
server.route("/debug", debugRoutes)
server.route("/models", modelRoutes)
server.route("/embeddings", embeddingRoutes)
server.route("/usage", usageRoute)
server.route("/token", tokenRoute)

// Compatibility with tools that expect v1/ prefix
server.route("/v1/chat/completions", completionRoutes)
server.route("/v1/models", modelRoutes)
server.route("/v1/embeddings", embeddingRoutes)

// OpenAI Responses API endpoint
server.route("/v1/responses", responsesRoutes)

// Anthropic compatible endpoints
server.route("/v1/messages", messageRoutes)
