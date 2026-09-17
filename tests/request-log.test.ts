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

describe("requestLogMiddleware hardening", () => {
  test("logs requests whose response body is never read", async () => {
    const logs: Array<string> = []
    const app = new Hono()
    app.use(createRequestLogMiddleware((line) => logs.push(line)))
    app.get("/", (c) => c.text("Server running"))

    // HEAD discards the body, so an observer that only fires at end-of-stream
    // never runs. hono/logger logged this unconditionally.
    await app.request("/", { method: "HEAD" })

    expect(logs).toHaveLength(1)
    expect(stripAnsi(logs[0] ?? "")).toContain("HEAD /")
  })

  test("non-string metadata cannot break the response body", async () => {
    const logs: Array<string> = []
    const app = new Hono()
    app.use(createRequestLogMiddleware((line) => logs.push(line)))
    app.post("/v1/responses", (c) => {
      // `reasoning.effort` is only structurally typed by a c.req.json<T>()
      // cast, so a client can put any JSON value here.
      setRequestLogMetadata(c, {
        model: 5.5 as unknown as string,
        effort: 123 as unknown as string,
      })
      return c.json({ error: { message: "upstream 400" } }, 400)
    })

    const response = await app.request("/v1/responses", { method: "POST" })
    const body = await response.text()

    expect(response.status).toBe(400)
    expect(body).toContain("upstream 400")
    expect(logs).toHaveLength(1)
  })

  test("control characters in metadata cannot forge a log line", async () => {
    const logs: Array<string> = []
    const app = new Hono()
    app.use(createRequestLogMiddleware((line) => logs.push(line)))
    app.post("/v1/messages", (c) => {
      setRequestLogMetadata(c, {
        model: "evil\n  --> GET /admin  200 | FORGED",
      })
      return c.json({})
    })

    await (await app.request("/v1/messages", { method: "POST" })).text()

    const line = stripAnsi(logs[0] ?? "")
    expect(logs).toHaveLength(1)
    expect(line).not.toContain("FORGED")
    expect(line).not.toContain("\n")
  })

  test("escape sequences in metadata cannot drive the terminal", async () => {
    const logs: Array<string> = []
    const escape = String.fromCodePoint(27)
    const app = new Hono()
    app.use(createRequestLogMiddleware((line) => logs.push(line)))
    app.post("/m", (c) => {
      setRequestLogMetadata(c, { model: `${escape}[2J${escape}[1;31mPWNED` })
      return c.json({})
    })

    await (await app.request("/m", { method: "POST" })).text()

    // colors.cyan() adds its own escapes, so assert on the interpolated value.
    expect(logs[0] ?? "").not.toContain(`${escape}[2J`)
  })

  test("distinguishes model names that differ only by version", async () => {
    const rendered: Array<string> = []
    for (const model of ["claude-sonnet-5", "claude-sonnet-4.6"]) {
      const logs: Array<string> = []
      const app = new Hono()
      app.use(createRequestLogMiddleware((line) => logs.push(line)))
      app.post("/m", (c) => {
        setRequestLogMetadata(c, { model })
        return c.json({})
      })
      await (await app.request("/m", { method: "POST" })).text()
      rendered.push(stripAnsi(logs[0] ?? ""))
    }

    expect(rendered[0]).toContain("claude-sonnet-5")
    expect(rendered[1]).toContain("claude-sonnet-4.6")
    expect(rendered[0]).not.toEqual(rendered[1])
  })

  test("does not leak response body contents into the log line", async () => {
    const logs: Array<string> = []
    const app = new Hono()
    app.use(createRequestLogMiddleware((line) => logs.push(line)))
    app.get("/token", (c) => c.json({ token: "tid=SECRET_VALUE;exp=1" }))

    await (await app.request("/token")).text()

    expect(stripAnsi(logs[0] ?? "")).not.toContain("SECRET_VALUE")
  })
})
