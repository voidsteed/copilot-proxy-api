import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { setRequestLogMetadata } from "~/lib/request-log"
import {
  createEmbeddings,
  type EmbeddingRequest,
} from "~/services/copilot/create-embeddings"

export const embeddingRoutes = new Hono()

embeddingRoutes.post("/", async (c) => {
  try {
    const payload = await c.req.json<EmbeddingRequest>()
    setRequestLogMetadata(c, { model: payload.model })
    const response = await createEmbeddings(payload)

    return c.json(response)
  } catch (error) {
    return await forwardError(c, error)
  }
})
