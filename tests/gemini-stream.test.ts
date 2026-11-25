import { afterEach, beforeEach, expect, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import { state } from "~/lib/state"
import { server } from "~/server"

const originalFetch = globalThis.fetch
const encoder = new TextEncoder()
const model: Model = {
  id: "gemini-3.8-flash",
  name: "Flash",
  vendor: "Google",
  object: "model",
  version: "1",
  preview: true,
  model_picker_enabled: true,
  supported_endpoints: ["/chat/completions"],
  capabilities: {
    family: "gemini",
    type: "chat",
    object: "model_capabilities",
    tokenizer: "o200k_base",
    limits: {},
    supports: {
      streaming: true,
      tool_calls: true,
      reasoning_effort: ["medium"],
    },
  },
}
const textRequest = {
  contents: [{ parts: [{ text: "hello" }] }],
  generationConfig: { thinkingConfig: { includeThoughts: true } },
}
beforeEach(() => {
  state.models = { object: "list", data: [model] }
  state.copilotToken = "fake-upstream"
  state.localApiKeys = []
  state.rateLimitSeconds = undefined
})
afterEach(() => {
  globalThis.fetch = originalFetch
  state.models = undefined
  state.localApiKeys = []
})
function event(delta: object, finish: string | null = null) {
  return `data: ${JSON.stringify({ id: "response-1", model: model.id, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
}
function streamFetch(
  body: ReadableStream<Uint8Array>,
  observe?: (init?: RequestInit) => void,
) {
  globalThis.fetch = Object.assign(
    (_input: string | URL | Request, init?: RequestInit) => {
      observe?.(init)
      return Promise.resolve(
        new Response(body, {
          headers: { "content-type": "text/event-stream" },
        }),
      )
    },
    { preconnect: originalFetch.preconnect },
  )
}
function generate(signal?: AbortSignal) {
  return server.request(
    `/v1beta/models/${model.id}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(textRequest),
      signal,
    },
  )
}
function decodeBytes(value: unknown): string {
  if (!(value instanceof Uint8Array)) throw new Error("Expected stream bytes")
  return new TextDecoder().decode(value)
}
function decodeEvents(text: string): Array<unknown> {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line): unknown => JSON.parse(line.slice(6)))
}
test("forwards streamed XHIGH for Neon and rejects it for unsupported models", async () => {
  const neon: Model = {
    ...model,
    id: "gemini-4-neon",
    capabilities: {
      ...model.capabilities,
      family: "gemini-4-neon",
      supports: { ...model.capabilities.supports, reasoning_effort: ["xhigh"] },
    },
  }
  state.models = { object: "list", data: [model, neon] }
  const sent: Array<unknown> = []
  streamFetch(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(event({ content: "hello" }, "stop")))
        controller.close()
      },
    }),
    (init) => {
      if (typeof init?.body === "string") sent.push(JSON.parse(init.body))
    },
  )
  const request = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...textRequest,
      generationConfig: { thinkingConfig: { thinkingLevel: "XHIGH" } },
    }),
  }
  const rejected = await server.request(
    `/v1beta/models/${model.id}:streamGenerateContent?alt=sse`,
    request,
  )
  expect(rejected.status).toBe(400)
  expect(sent).toHaveLength(0)

  const accepted = await server.request(
    `/v1beta/models/${neon.id}:streamGenerateContent?alt=sse`,
    request,
  )
  expect(accepted.status).toBe(200)
  expect(await accepted.text()).toContain('"text":"hello"')
  expect(sent).toEqual([
    expect.objectContaining({ model: neon.id, reasoning_effort: "xhigh" }),
  ])
})
test("reasoning and text arrive before the upstream tail and usage follows finish", async () => {
  const tail = Promise.withResolvers<undefined>()
  streamFetch(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            event({ reasoning_text: "thinking" }) + event({ content: "first" }),
          ),
        )
        void tail.promise.then(() => {
          controller.enqueue(encoder.encode(event({ content: "last" }, "stop")))
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } })}\n\ndata: [DONE]\n\n`,
            ),
          )
          controller.close()
        })
      },
    }),
  )
  const response = await generate()
  expect(response.headers.get("content-type")).toContain("text/event-stream")
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Missing body")
  const first = await reader.read()
  let body = decodeBytes(first.value)
  while (!body.includes("thinking") || !body.includes("first")) {
    const next = await reader.read()
    if (next.done) throw new Error("Stream ended before held tail")
    body += decodeBytes(next.value)
  }
  expect(body).toContain("thinking")
  expect(body).toContain("first")
  tail.resolve(undefined)
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    body += decodeBytes(next.value)
  }
  expect(body).toContain("first")
  expect(body).toContain("last")
  expect(body).not.toContain("[DONE]")
  expect(decodeEvents(body).at(-1)).toMatchObject({
    candidates: [{ finishReason: "STOP" }],
    usageMetadata: {
      promptTokenCount: 9,
      candidatesTokenCount: 4,
      totalTokenCount: 13,
    },
  })
})
test("fragmented parallel calls are ordered and the first call carries the completed authentic signature", async () => {
  const body =
    event({ content: "calling" })
    + event({
      tool_calls: [
        {
          index: 1,
          id: "second",
          function: { name: "read", arguments: '{"n":' },
        },
        {
          index: 0,
          id: "first",
          function: { name: "read", arguments: '{"n":' },
        },
      ],
    })
    + event(
      {
        tool_calls: [
          { index: 0, function: { arguments: "1}" } },
          { index: 1, function: { arguments: "2}" } },
        ],
        reasoning_opaque: "opaque+",
      },
      "tool_calls",
    )
    + event({ reasoning_opaque: "/==" })
    + "data: [DONE]\n\n"
  streamFetch(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body))
        controller.close()
      },
    }),
  )
  const response = await generate()
  const chunks = decodeEvents(await response.text())
  expect(chunks[0]).toMatchObject({
    candidates: [{ content: { parts: [{ text: "calling" }] } }],
  })
  expect(chunks.at(-1)).toMatchObject({
    candidates: [
      {
        content: {
          parts: [
            {
              functionCall: { id: "first", name: "read", args: { n: 1 } },
              thoughtSignature: "opaque+/==",
            },
            { functionCall: { id: "second", name: "read", args: { n: 2 } } },
          ],
        },
        finishReason: "STOP",
      },
    ],
  })
})
test("safety and length finishes keep their meaning without invented usage", async () => {
  for (const [upstream, expected] of [
    ["content_filter", "SAFETY"],
    ["length", "MAX_TOKENS"],
  ]) {
    streamFetch(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(event({}, upstream) + "data: [DONE]\n\n"),
          )
          controller.close()
        },
      }),
    )
    const text = await (await generate()).text()
    expect(decodeEvents(text).at(-1)).toMatchObject({
      candidates: [{ finishReason: expected }],
    })
    expect(text).not.toContain("usageMetadata")
  }
})
test("truncated and invalid streams expose an error after headers", async () => {
  for (const body of [
    event({ content: "partial" }),
    event(
      {
        tool_calls: [
          {
            index: 0,
            id: "a",
            function: { name: "read", arguments: "{broken" },
          },
        ],
      },
      "tool_calls",
    ),
  ]) {
    streamFetch(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(body))
          controller.close()
        },
      }),
    )
    const response = await generate()
    expect(response.status).toBe(200)
    expect(decodeEvents(await response.text()).at(-1)).toMatchObject({
      error: { code: 502, status: "UNAVAILABLE" },
    })
  }
})
test("downstream cancellation aborts the upstream signal and cancels its reader", async () => {
  let upstreamSignal: AbortSignal | null | undefined
  const cancelled = Promise.withResolvers<undefined>()
  streamFetch(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(event({ content: "first" })))
      },
      cancel() {
        cancelled.resolve(undefined)
      },
    }),
    (init) => {
      upstreamSignal = init?.signal
    },
  )
  const response = await generate()
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Missing body")
  await reader.read()
  await reader.cancel()
  await cancelled.promise
  expect(upstreamSignal?.aborted).toBe(true)
})

test("raw request abort before headers cancels the real upstream fetch", async () => {
  const started = Promise.withResolvers<undefined>()
  let upstreamSignal: AbortSignal | null | undefined
  globalThis.fetch = Object.assign(
    (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        upstreamSignal = init?.signal
        started.resolve(undefined)
        init?.signal?.addEventListener(
          "abort",
          () => {
            reject(new DOMException("Cancelled", "AbortError"))
          },
          { once: true },
        )
      }),
    { preconnect: originalFetch.preconnect },
  )
  const controller = new AbortController()
  const pending = generate(controller.signal)
  await started.promise
  controller.abort()
  const response = await pending
  expect(upstreamSignal?.aborted).toBe(true)
  expect(response.status).toBe(499)
  expect(await response.json()).toMatchObject({
    error: { status: "CANCELLED" },
  })
})

test("nullable stream fields and reasoning_tokens succeed without false 502s", async () => {
  const body =
    `data: ${JSON.stringify({
      id: "response-nulls",
      model: model.id,
      choices: [
        {
          index: 0,
          delta: {
            content: "hi",
            tool_calls: null,
          },
          finish_reason: null,
        },
      ],
      usage: null,
    })}\n\n`
    + `data: ${JSON.stringify({
      id: null,
      model: null,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "read", arguments: '{"a":' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
      usage: null,
    })}\n\n`
    + `data: ${JSON.stringify({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: null,
                type: null,
                function: { name: null, arguments: "1}" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: null,
    })}\n\n`
    + `data: ${JSON.stringify({
      choices: [],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 8,
        total_tokens: 18,
        prompt_tokens_details: null,
        completion_tokens_details: { reasoning_tokens: 5 },
      },
    })}\n\n`
    + "data: [DONE]\n\n"
  streamFetch(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body))
        controller.close()
      },
    }),
  )
  const response = await generate()
  expect(response.status).toBe(200)
  const chunks = decodeEvents(await response.text())
  expect(chunks.at(-1)).toMatchObject({
    responseId: "response-nulls",
    modelVersion: model.id,
    candidates: [
      {
        content: {
          parts: [
            { functionCall: { id: "call_1", name: "read", args: { a: 1 } } },
          ],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 8,
      totalTokenCount: 18,
      thoughtsTokenCount: 5,
    },
  })
})

test("malformed JSON in upstream SSE emits a 502 Gemini error event", async () => {
  streamFetch(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("data: {not-json\n\n"))
        controller.close()
      },
    }),
  )
  const response = await generate()
  expect(response.status).toBe(200)
  expect(decodeEvents(await response.text()).at(-1)).toEqual({
    error: {
      code: 502,
      status: "UNAVAILABLE",
      message: "Invalid upstream stream event",
    },
  })
})
