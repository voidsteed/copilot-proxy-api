import { afterEach, describe, expect, test } from "bun:test"
import { stripAnsi } from "consola/utils"
import { Hono } from "hono"

import {
  createRequestLogMiddleware,
  setRequestLogMetadata,
} from "~/lib/request-log"
import { state } from "~/lib/state"

afterEach(() => {
  state.models = undefined
})

function setModel(model: string, contextLimit = 1_000_000): void {
  state.models = {
    object: "list",
    data: [
      {
        id: model,
        object: "model",
        name: model,
        model_picker_enabled: true,
        preview: false,
        vendor: "openai",
        version: "1",
        capabilities: {
          family: model,
          limits: { max_context_window_tokens: contextLimit },
          object: "model_capabilities",
          supports: {},
          tokenizer: "o200k_base",
          type: "chat",
        },
      },
    ],
  }
}

describe("requestLogMiddleware", () => {
  test("formats JSON response usage as a compact request summary", async () => {
    setModel("gpt-5.5")
    const logs: Array<string> = []
    const app = new Hono()
    app.use(createRequestLogMiddleware((line) => logs.push(line)))
    app.post("/v1/responses", (c) => {
      setRequestLogMetadata(c, { model: "gpt-5.5", effort: "medium" })
      return c.json({
        usage: {
          input_tokens: 12_000,
          output_tokens: 365,
          total_tokens: 12_365,
          input_tokens_details: { cached_tokens: 8_000 },
        },
      })
    })

    const response = await app.request("/v1/responses", { method: "POST" })
    await response.text()

    expect(logs).toHaveLength(1)
    const line = stripAnsi(logs[0] ?? "")
    expect(line).toContain("--> POST /v1/responses")
    expect(line).toContain("200")
    expect(line).toMatch(/gpt-5\.5\s+medium/)
    expect(line).not.toContain("effort")
    expect(line).toContain("tokens ↑  12K cache   8K ↓  365")
    expect(line).toContain("context 12K/1M (1%)")
    expect(line).not.toContain("first-token")
    expect(line).toContain("total")
  })

  test("extracts usage from SSE responses", async () => {
    setModel("gpt-5.6-luna")
    const logs: Array<string> = []
    const app = new Hono()
    app.use(createRequestLogMiddleware((line) => logs.push(line)))
    app.get("/v1/responses", (c) => {
      setRequestLogMetadata(c, { model: "gpt-5.6-luna", effort: "low" })
      return new Response(
        [
          `data: ${JSON.stringify({
            type: "response.output_text.delta",
            delta: "OK",
          })}`,
          `data: ${JSON.stringify({
            type: "response.completed",
            response: {
              usage: {
                input_tokens: 11_000,
                output_tokens: 27,
                total_tokens: 11_027,
              },
            },
          })}`,
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { headers: { "content-type": "text/event-stream" } },
      )
    })

    const response = await app.request("/v1/responses")
    await response.text()

    expect(logs).toHaveLength(1)
    const line = stripAnsi(logs[0] ?? "")
    expect(line).toMatch(/gpt-5\.6-luna\s+low/)
    expect(line).not.toContain("effort")
    expect(line).toContain("tokens ↑  11K            ↓   27")
    expect(line).not.toContain("first-token")
    expect(line).toContain("total")
  })
})
