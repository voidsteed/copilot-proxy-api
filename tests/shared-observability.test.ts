import { expect, test } from "bun:test"
import { Hono } from "hono"

import type { CompletedRequestSummary } from "~/lib/request-log"

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
  app.post("/v1beta/models/:action", (c) => {
    setRequestLogMetadata(c, { model: "gemini-fixture", effort: "medium" })
    return new Response(body, {
      headers: {
        "content-type": streaming ? "text/event-stream" : "application/json",
      },
    })
  })
  return { app, completed, lines }
}

test("Google JSON usage preserves known values and omits unknown counts", async () => {
  const { app, completed } = observedApp(
    JSON.stringify({
      usageMetadata: { promptTokenCount: 123, cachedContentTokenCount: 20 },
    }),
  )
  await (
    await app.request("/v1beta/models/gemini-fixture:generateContent", {
      method: "POST",
    })
  ).text()
  expect(completed).toHaveLength(1)
  expect(completed[0]).toMatchObject({
    model: "gemini-fixture",
    outcome: "completed",
    inputTokens: 123,
    outputTokens: null,
    cachedTokens: 20,
  })
})

test("Google streaming records terminal usage once without storing content or credentials", async () => {
  clearRequestTraces()
  const { app, completed, lines } = observedApp(
    [
      'data: {"candidates":[{"content":{"parts":[{"text":"private output"}]}}]}\n\n',
      'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":42,"candidatesTokenCount":7,"cachedContentTokenCount":0}}\n\n',
    ].join(""),
    true,
  )
  await (
    await app.request(
      "/v1beta/models/gemini-fixture:streamGenerateContent?alt=sse&key=query-private",
      { method: "POST", headers: { "x-goog-api-key": "header-private" } },
    )
  ).text()
  expect(completed).toHaveLength(1)
  expect(completed[0]).toMatchObject({
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
})

test("Google SSE errors and missing terminal events are failed outcomes", async () => {
  for (const body of [
    'data: {"error":{"code":503,"message":"private failure"}}\n\n',
    'data: {"candidates":[{"content":{"parts":[{"text":"unfinished"}]}}]}\n\n',
  ]) {
    const { app, completed, lines } = observedApp(body, true)
    await (
      await app.request(
        "/v1beta/models/gemini-fixture:streamGenerateContent?alt=sse",
        { method: "POST" },
      )
    ).text()
    expect(completed).toHaveLength(1)
    expect(completed[0]?.outcome).toBe("failed")
    expect(JSON.stringify(lines)).not.toContain("private failure")
  }
})

test("Google stream cancellation records a single cancelled outcome with unknown usage", async () => {
  const completed: Array<CompletedRequestSummary> = []
  let cancelled = false
  const app = new Hono()
  app.use(
    createRequestLogMiddleware(
      () => undefined,
      (record) => completed.push(record),
    ),
  )
  app.post("/v1beta/models/:action", (c) => {
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
  const abort = new AbortController()
  const response = await app.request(
    "/v1beta/models/gemini-fixture:streamGenerateContent?alt=sse",
    { method: "POST", signal: abort.signal },
  )
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Expected stream")
  await reader.read()
  abort.abort()
  await reader.cancel()
  expect(cancelled).toBe(true)
  expect(completed).toHaveLength(1)
  expect(completed[0]).toMatchObject({
    outcome: "cancelled",
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
  })
})
