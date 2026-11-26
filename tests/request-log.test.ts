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

function requestWithRawHeaders(
  url: string,
  headers: Record<string, string>,
  init?: Omit<RequestInit, "headers">,
): Request {
  const request = new Request(url, init)
  const map = new Map<string, string>(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  )
  Object.defineProperty(request, "headers", {
    value: {
      get: (name: string) => map.get(name.toLowerCase()) ?? null,
      has: (name: string) => map.has(name.toLowerCase()),
      forEach: (callback: (value: string, key: string) => void) => {
        for (const [key, value] of map) callback(value, key)
      },
      entries: () => map.entries(),
      keys: () => map.keys(),
      values: () => map.values(),
      [Symbol.iterator]: () => map.entries(),
    },
  })
  return request
}

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
  test.each(["response.failed", "response.incomplete"])(
    "logs %s even when the upstream HTTP status is 200",
    async (type) => {
      const logs: Array<string> = []
      const app = new Hono()
      app.use(createRequestLogMiddleware((line) => logs.push(line)))
      const body = `data: ${JSON.stringify({
        type,
        response: {
          error: { code: "invalid_request_body", message: "PRIVATE_CONTENT" },
          incomplete_details: { reason: "max_output_tokens" },
        },
      })}\n\n`
      app.get(
        "/v1/responses",
        () =>
          new Response(body, {
            headers: { "content-type": "text/event-stream" },
          }),
      )

      const response = await app.request("/v1/responses")
      expect(await response.text()).toBe(body)
      expect(logs).toHaveLength(1)
      const line = stripAnsi(logs[0] ?? "")
      expect(line).toContain(type)
      expect(line).toContain(
        type === "response.failed" ?
          "invalid_request_body"
        : "max_output_tokens",
      )
      expect(line).not.toContain("PRIVATE_CONTENT")
    },
  )

  test("logs a Responses stream that closes before a terminal event", async () => {
    const logs: Array<string> = []
    const app = new Hono()
    app.use(createRequestLogMiddleware((line) => logs.push(line)))
    const body = 'data: {"type":"response.created"}\n\n'
    app.get(
      "/v1/responses",
      () =>
        new Response(body, {
          headers: { "content-type": "text/event-stream" },
        }),
    )

    expect(await (await app.request("/v1/responses")).text()).toBe(body)
    expect(stripAnsi(logs[0] ?? "")).toContain(
      "Responses stream closed before a terminal event",
    )
  })

  test("does not report completed Responses or other SSE routes as truncated", async () => {
    const logs: Array<string> = []
    const app = new Hono()
    app.use(createRequestLogMiddleware((line) => logs.push(line)))
    app.get(
      "/v1/responses",
      () =>
        new Response('data: {"type":"response.completed"}\n\n', {
          headers: { "content-type": "text/event-stream" },
        }),
    )
    app.get(
      "/v1/messages",
      () =>
        new Response('data: {"type":"message_stop"}\n\n', {
          headers: { "content-type": "text/event-stream" },
        }),
    )

    await (await app.request("/v1/responses")).text()
    await (await app.request("/v1/messages")).text()
    expect(logs).toHaveLength(2)
    for (const line of logs) {
      expect(stripAnsi(line)).not.toContain("closed before")
    }
  })

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

describe("requestLogMiddleware client metadata", () => {
  test("logs sanitized client metadata on 4xx and 5xx responses but omits it on clean 200 responses", async () => {
    const logs: Array<string> = []
    const app = new Hono()
    app.use(createRequestLogMiddleware((line) => logs.push(line)))
    app.post("/v1/chat/completions", (c) => {
      const statusParam = c.req.query("status")
      if (statusParam === "400")
        return c.json({ error: { message: "bad request" } }, 400)
      if (statusParam === "502")
        return c.json({ error: { message: "bad gateway" } }, 502)
      return c.json({ id: "ok" })
    })

    const headers = {
      "user-agent": "python-urllib/3.12",
      "x-forwarded-for": "100.64.225.91",
    }

    await (
      await app.request("/v1/chat/completions?status=400", {
        method: "POST",
        headers,
      })
    ).text()
    await (
      await app.request("/v1/chat/completions?status=502", {
        method: "POST",
        headers,
      })
    ).text()
    await (
      await app.request("/v1/chat/completions", {
        method: "POST",
        headers,
      })
    ).text()

    expect(logs).toHaveLength(3)
    for (const errorLine of [
      stripAnsi(logs[0] ?? ""),
      stripAnsi(logs[1] ?? ""),
    ]) {
      expect(errorLine).toContain("python-urllib/3.12")
      expect(errorLine).toContain("100.64.225.91")
    }

    const okLine = stripAnsi(logs[2] ?? "")
    expect(okLine).toContain("200")
    expect(okLine).not.toContain("client ")
    expect(okLine).not.toContain("python-urllib/3.12")
    expect(okLine).not.toContain("100.64.225.91")
  })

  test("control characters and terminal escapes in client headers cannot forge lines or inject ESC sequences", async () => {
    const logs: Array<string> = []
    const escape = String.fromCodePoint(27)
    const app = new Hono()
    app.use(createRequestLogMiddleware((line) => logs.push(line)))
    app.post("/v1/chat/completions", (c) =>
      c.json({ error: { message: "bad request" } }, 400),
    )

    await (
      await app.fetch(
        requestWithRawHeaders(
          "http://localhost/v1/chat/completions",
          {
            "user-agent": `BadClient\nFORGED${escape}[2J`,
            "x-forwarded-for": `100.64.225.91\r${escape}[31m`,
          },
          { method: "POST" },
        ),
      )
    ).text()

    await (
      await app.fetch(
        requestWithRawHeaders(
          "http://localhost/v1/chat/completions",
          {
            origin: `http://evil.test\r\nFORGED${escape}[2J`,
          },
          { method: "POST" },
        ),
      )
    ).text()

    await (
      await app.fetch(
        requestWithRawHeaders(
          "http://localhost/v1/chat/completions",
          {
            "x-forwarded-for": `100.64.225.91\r\nFORGED${escape}[2J`,
          },
          { method: "POST" },
        ),
      )
    ).text()

    expect(logs).toHaveLength(3)

    const uaRaw = logs[0] ?? ""
    const uaLine = stripAnsi(uaRaw)
    expect(uaLine).toContain("BadClient")
    expect(uaLine).not.toContain("\n")
    expect(uaLine).not.toContain("\r")
    expect(uaRaw).not.toContain(`${escape}[2J`)
    expect(uaRaw).not.toContain(`${escape}[31m`)

    const originRaw = logs[1] ?? ""
    const originLine = stripAnsi(originRaw)
    expect(originLine).toContain("evil.test")
    expect(originLine).not.toContain("\n")
    expect(originLine).not.toContain("\r")
    expect(originRaw).not.toContain(`${escape}[2J`)

    const ipRaw = logs[2] ?? ""
    const ipLine = stripAnsi(ipRaw)
    expect(ipLine).not.toContain("\n")
    expect(ipLine).not.toContain("\r")
    expect(ipRaw).not.toContain(`${escape}[2J`)
  })
})

describe("requestLogMiddleware Gemini SSE", () => {
  test.each([
    "/v1beta/models/gemini-4-neon:streamGenerateContent",
    "/v1/models/gemini-4-neon:streamGenerateContent",
  ])(
    "extracts Gemini SSE usageMetadata and detects truncated streams on %s",
    async (path) => {
      setModel("gemini-4-neon")
      const logs: Array<string> = []
      const app = new Hono()
      app.use(createRequestLogMiddleware((line) => logs.push(line)))
      app.post(path, (c) => {
        setRequestLogMetadata(c, { model: "gemini-4-neon", effort: "xhigh" })
        const truncated = c.req.query("truncated") === "1"
        const body =
          truncated ?
            `data: ${JSON.stringify({
              candidates: [
                {
                  index: 0,
                  content: { role: "model", parts: [{ text: "partial" }] },
                },
              ],
            })}\n\n`
          : `data: ${JSON.stringify({
              candidates: [
                {
                  index: 0,
                  content: { role: "model", parts: [{ text: "done" }] },
                  finishReason: "STOP",
                },
              ],
              usageMetadata: {
                promptTokenCount: 15_000,
                candidatesTokenCount: 420,
                cachedContentTokenCount: 5_000,
              },
            })}\n\n`
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
        })
      })

      await (await app.request(`${path}?alt=sse`, { method: "POST" })).text()
      await (
        await app.request(`${path}?alt=sse&truncated=1`, { method: "POST" })
      ).text()

      expect(logs).toHaveLength(2)
      const completeLine = stripAnsi(logs[0] ?? "")
      expect(completeLine).toContain("gemini-4-neon")
      expect(completeLine).toContain("xhigh")
      expect(completeLine).toContain("tokens ↑  15K cache   5K ↓  420")
      expect(completeLine).not.toContain("closed before")

      const truncatedLine = stripAnsi(logs[1] ?? "")
      expect(truncatedLine).toContain(
        "Gemini stream closed before a terminal event",
      )
    },
  )

  test("logs Gemini SSE in-band error code and status without leaking the error message", async () => {
    setModel("gemini-4-neon")
    const logs: Array<string> = []
    const app = new Hono()
    app.use(createRequestLogMiddleware((line) => logs.push(line)))
    app.post("/v1beta/models/gemini-4-neon:streamGenerateContent", (c) => {
      setRequestLogMetadata(c, { model: "gemini-4-neon", effort: "xhigh" })
      const body = `data: ${JSON.stringify({
        error: { code: 502, status: "UNAVAILABLE", message: "PRIVATE" },
      })}\n\n`
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      })
    })

    await (
      await app.request(
        "/v1beta/models/gemini-4-neon:streamGenerateContent?alt=sse",
        { method: "POST" },
      )
    ).text()

    expect(logs).toHaveLength(1)
    const line = stripAnsi(logs[0] ?? "")
    expect(line).toContain("Response stream failed (502 UNAVAILABLE)")
    expect(line).not.toContain("PRIVATE")
  })

  test("logs client metadata on 200 Gemini SSE error, supports %3A paths, and rejects blank finishReason as terminal", async () => {
    setModel("gemini-4-neon")
    const logs: Array<string> = []
    const app = new Hono()
    app.use(createRequestLogMiddleware((line) => logs.push(line)))
    app.post("/v1beta/models/:model", (c) => {
      setRequestLogMetadata(c, { model: "gemini-4-neon", effort: "high" })
      const body =
        c.req.query("mode") === "blank-finish" ?
          `data: ${JSON.stringify({
            candidates: [
              {
                index: 0,
                content: { role: "model", parts: [{ text: "partial" }] },
                finishReason: "",
              },
            ],
          })}\n\n`
        : `data: ${JSON.stringify({
            error: { code: 502, status: "UNAVAILABLE", message: "SECRET" },
          })}\n\n`
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      })
    })

    await (
      await app.request(
        "/v1beta/models/gemini-4-neon%3AstreamGenerateContent?alt=sse",
        {
          method: "POST",
          headers: {
            "user-agent": "AgyClient/1.5",
            "x-forwarded-for": "100.64.225.91",
          },
        },
      )
    ).text()
    await (
      await app.request(
        "/v1beta/models/gemini-4-neon%3AstreamGenerateContent?alt=sse&mode=blank-finish",
        {
          method: "POST",
          headers: { "user-agent": "AgyClient/1.5" },
        },
      )
    ).text()

    expect(logs).toHaveLength(2)
    const errLine = stripAnsi(logs[0] ?? "")
    expect(errLine).toContain("Response stream failed (502 UNAVAILABLE)")
    expect(errLine).toContain("AgyClient/1.5")
    expect(errLine).toContain("100.64.225.91")
    expect(errLine).not.toContain("SECRET")

    const truncatedLine = stripAnsi(logs[1] ?? "")
    expect(truncatedLine).toContain(
      "Gemini stream closed before a terminal event",
    )
    expect(truncatedLine).toContain("AgyClient/1.5")
  })
})
