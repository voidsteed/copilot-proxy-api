import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import {
  type CompletedRequestSummary,
  createRequestLogMiddleware,
} from "~/lib/request-log"

describe("desktop Responses alias metrics", () => {
  for (const path of ["/responses", "/v1/responses"]) {
    for (const event of [
      {
        type: "response.failed",
        response: {
          error: {
            code: "fixture_failure",
            message: "private upstream detail",
          },
        },
      },
      { type: "response.output_text.delta", delta: "private generated text" },
    ]) {
      test(`${path} records ${event.type} as a failed stream`, async () => {
        const records: Array<CompletedRequestSummary> = []
        const app = new Hono()
        app.use(
          createRequestLogMiddleware(
            () => undefined,
            (record) => records.push(record),
          ),
        )
        app.post(
          path,
          () =>
            new Response(`data: ${JSON.stringify(event)}\n\n`, {
              headers: { "content-type": "text/event-stream" },
            }),
        )
        const response = await app.request(path, { method: "POST" })
        expect(response.status).toBe(200)
        await response.text()
        expect(records).toHaveLength(1)
        expect(records[0]?.outcome).toBe("failed")
        expect(JSON.stringify(records)).not.toContain("private")
      })
    }
  }
})
