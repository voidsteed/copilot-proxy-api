import { expect, test } from "bun:test"
import { Hono } from "hono"

import type { CompletedRequestSummary } from "~/lib/request-log"

import { isGeminiInferencePath, isInferencePath } from "~/lib/inference-path"
import {
  createRequestLogMiddleware,
  setRequestLogMetadata,
} from "~/lib/request-log"
import {
  clearRequestTraces,
  getRequestTraces,
  requestTraceMiddleware,
} from "~/lib/request-trace"

function observedApp(body: string, streaming = false) {
  const completed: Array<CompletedRequestSummary> = []
  const lines: Array<string> = []
  const app = new Hono()
  app.use(requestTraceMiddleware)
  app.use(
    createRequestLogMiddleware(
      (line) => lines.push(line),
      (summary) => completed.push(summary),
    ),
  )
  for (const prefix of ["/v1/models", "/v1beta/models"]) {
    app.post(`${prefix}/:action`, (c) => {
      setRequestLogMetadata(c, { model: "gemini-fixture", effort: "medium" })
      return new Response(body, {
        headers: {
          "content-type": streaming ? "text/event-stream" : "application/json",
        },
      })
    })
  }
  return { app, completed, lines }
}

test("inference path classification covers both v1 and v1beta Gemini inference endpoints", () => {
  for (const path of [
    "/v1/models/gemini-4-neon:generateContent",
    "/v1/models/gemini-4-neon:streamGenerateContent",
    "/v1beta/models/gemini-4-neon:generateContent",
    "/v1beta/models/gemini-4-neon:streamGenerateContent",
  ]) {
    expect(isGeminiInferencePath(path)).toBe(true)
    expect(isInferencePath(path)).toBe(true)
  }

  for (const path of [
    "/chat/completions",
    "/v1/chat/completions",
    "/responses",
    "/v1/responses",
    "/messages",
    "/v1/messages",
    "/embeddings",
    "/v1/embeddings",
  ]) {
    expect(isGeminiInferencePath(path)).toBe(false)
    expect(isInferencePath(path)).toBe(true)
  }

  for (const path of [
    "/v1/models",
    "/v1beta/models",
    "/v1/models/gemini-4-neon",
    "/v1/models/gpt-5/codex-config",
  ]) {
    expect(isGeminiInferencePath(path)).toBe(false)
    expect(isInferencePath(path)).toBe(false)
  }
})

test.each([
  "/v1beta/models/gemini-fixture:generateContent",
  "/v1/models/gemini-fixture:generateContent",
])(
  "Google JSON usage preserves known values and omits unknown counts on %s",
  async (path) => {
    const { app, completed } = observedApp(
      JSON.stringify({
        usageMetadata: { promptTokenCount: 123, cachedContentTokenCount: 20 },
      }),
    )
    await (await app.request(path, { method: "POST" })).text()
    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({
      path,
      model: "gemini-fixture",
      outcome: "completed",
      inputTokens: 123,
      outputTokens: null,
      cachedTokens: 20,
    })
  },
)

test.each([
  "/v1beta/models/gemini-fixture:streamGenerateContent",
  "/v1/models/gemini-fixture:streamGenerateContent",
])(
  "Google streaming records terminal usage once without storing content or credentials on %s",
  async (path) => {
    clearRequestTraces()
    const { app, completed, lines } = observedApp(
      [
        'data: {"candidates":[{"content":{"parts":[{"text":"private output"}]}}]}\n\n',
        'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":42,"candidatesTokenCount":7,"cachedContentTokenCount":0}}\n\n',
      ].join(""),
      true,
    )
    await (
      await app.request(`${path}?alt=sse&key=query-private`, {
        method: "POST",
        headers: { "x-goog-api-key": "header-private" },
      })
    ).text()
    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({
      path,
      inputTokens: 42,
      outputTokens: 7,
      cachedTokens: 0,
      outcome: "completed",
    })
    const retained = JSON.stringify({
      completed,
      lines,
      traces: getRequestTraces(),
    })
    for (const secret of [
      "query-private",
      "header-private",
      "private output",
      "x-goog-api-key",
    ])
      expect(retained).not.toContain(secret)
  },
)

test.each([
  "/v1beta/models/gemini-fixture:streamGenerateContent",
  "/v1/models/gemini-fixture:streamGenerateContent",
])(
  "Google SSE errors and missing terminal events are failed outcomes on %s",
  async (path) => {
    for (const body of [
      'data: {"error":{"code":503,"message":"private failure"}}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"unfinished"}]}}]}\n\n',
    ]) {
      const { app, completed, lines } = observedApp(body, true)
      await (await app.request(`${path}?alt=sse`, { method: "POST" })).text()
      expect(completed).toHaveLength(1)
      expect(completed[0]?.outcome).toBe("failed")
      expect(JSON.stringify(lines)).not.toContain("private failure")
    }
  },
)

test.each([
  "/v1beta/models/gemini-fixture:streamGenerateContent",
  "/v1/models/gemini-fixture:streamGenerateContent",
])(
  "Google stream cancellation records a single cancelled outcome with unknown usage on %s",
  async (path) => {
    const completed: Array<CompletedRequestSummary> = []
    let cancelled = false
    const app = new Hono()
    app.use(
      createRequestLogMiddleware(
        () => undefined,
        (record) => completed.push(record),
      ),
    )
    for (const prefix of ["/v1/models", "/v1beta/models"]) {
      app.post(`${prefix}/:action`, (c) => {
        setRequestLogMetadata(c, { model: "gemini-fixture" })
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n',
                ),
              )
            },
            cancel() {
              cancelled = true
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      })
    }
    const abort = new AbortController()
    const response = await app.request(`${path}?alt=sse`, {
      method: "POST",
      signal: abort.signal,
    })
    const reader = response.body?.getReader()
    if (!reader) throw new Error("Expected stream")
    await reader.read()
    abort.abort()
    await reader.cancel()
    expect(cancelled).toBe(true)
    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({
      path,
      outcome: "cancelled",
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
    })
  },
)
