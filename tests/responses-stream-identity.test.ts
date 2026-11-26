import { afterEach, expect, mock, spyOn, test } from "bun:test"

import type { ResponsesApiRequest } from "~/routes/responses/types"

import { state } from "~/lib/state"
import { createResponses } from "~/services/copilot/create-responses"
import {
  normalizeResponsesStreamIdentity,
  restoreResponsesReplayIds,
} from "~/services/copilot/responses-stream-identity"

const originalFetch = globalThis.fetch
const originalState = {
  copilotToken: state.copilotToken,
  githubToken: state.githubToken,
  accountType: state.accountType,
  vsCodeVersion: state.vsCodeVersion,
  models: state.models,
  responsesContextTrim: state.responsesContextTrim,
}

afterEach(() => {
  mock.restore()
  globalThis.fetch = originalFetch
  state.copilotToken = originalState.copilotToken
  state.githubToken = originalState.githubToken
  state.accountType = originalState.accountType
  state.vsCodeVersion = originalState.vsCodeVersion
  state.models = originalState.models
  state.responsesContextTrim = originalState.responsesContextTrim
})

function bodyToString(body: unknown): string {
  if (typeof body !== "string") {
    throw new TypeError("expected fetch body to be a string")
  }
  return body
}

test("correlates rotating IDs and restores opaque IDs for upstream replay", async () => {
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "added-id", type: "reasoning", summary: [] },
    },
    {
      type: "response.reasoning_summary_text.delta",
      output_index: 0,
      item_id: "delta-id",
      delta: "thinking",
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "final-id",
        type: "reasoning",
        encrypted_content: "ciphertext",
        summary: [],
      },
    },
    {
      type: "response.completed",
      response: {
        output: [
          {
            id: "final-id",
            type: "reasoning",
            encrypted_content: "ciphertext",
          },
        ],
      },
    },
  ]
  const serialized = events
    .map(
      (event) =>
        `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`,
    )
    .join("")
  const bytes = new TextEncoder().encode(serialized)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 7)
        controller.enqueue(bytes.slice(offset, offset + 7))
      controller.close()
    },
  })
  const normalized = await normalizeResponsesStreamIdentity(
    new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    "identity-test",
  ).text()
  expect(normalized).not.toContain("delta-id")
  expect(normalized).not.toContain("final-id")
  expect(normalized).toContain("ciphertext")
  const payload = {
    model: "test",
    input: [
      { type: "reasoning", id: "added-id", encrypted_content: "ciphertext" },
    ],
  }
  expect(restoreResponsesReplayIds(payload, "identity-test").input).toEqual([
    { type: "reasoning", id: "final-id", encrypted_content: "ciphertext" },
  ])
  expect(restoreResponsesReplayIds(payload, "other-account").input).toEqual(
    payload.input,
  )
})

test("preserves valid SSE comments, unknown events, Unicode, and tool call IDs", async () => {
  const body =
    ': heartbeat\n\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"tool-added","type":"function_call","call_id":"call-keep"}}\n\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"tool-final","type":"function_call","call_id":"call-keep","arguments":"你好"}}\n\ndata: [DONE]\n\n'
  const response = normalizeResponsesStreamIdentity(
    new Response(body, { headers: { "content-type": "text/event-stream" } }),
    "tools",
  )
  const text = await response.text()
  expect(text).toContain(": heartbeat")
  expect(text).toContain("call-keep")
  expect(text).toContain("你好")
  expect(text).not.toContain("tool-final")
  expect(text).toContain("data: [DONE]")
})

test("cancellation propagates through the identity transform", async () => {
  let cancelled = false
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(": ready\n\n"))
    },
    cancel() {
      cancelled = true
    },
  })
  const response = normalizeResponsesStreamIdentity(
    new Response(upstream, {
      headers: { "content-type": "text/event-stream" },
    }),
    "cancel",
  )
  if (!response.body) throw new Error("Missing body")
  const reader = response.body.getReader()
  await reader.read()
  await reader.cancel()
  await Bun.sleep(0)
  expect(cancelled).toBe(true)
})

test("createResponses normalizes turn 1 stream, strips framing headers, restores turn 2 replay ID, and isolates account and model", async () => {
  state.copilotToken = "identity-copilot-token"
  state.githubToken = "account-a"
  state.accountType = "individual"
  state.vsCodeVersion = "1.0.0"
  state.models = undefined

  const sseBody = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "turn1-added", type: "reasoning", summary: [] },
    },
    {
      type: "response.reasoning_summary_text.delta",
      output_index: 0,
      item_id: "turn1-delta",
      delta: "step",
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "turn1-final",
        type: "reasoning",
        encrypted_content: "cipher-1",
        summary: [],
      },
    },
    {
      type: "response.completed",
      response: {
        output: [
          {
            id: "turn1-final",
            type: "reasoning",
            encrypted_content: "cipher-1",
          },
        ],
      },
    },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("")

  let callIndex = 0
  const sentPayloads: Array<ResponsesApiRequest> = []
  const fetchMock = mock((_url: string, opts: RequestInit) => {
    sentPayloads.push(
      JSON.parse(bodyToString(opts.body)) as ResponsesApiRequest,
    )
    callIndex += 1
    if (callIndex === 1) {
      return new Response(sseBody, {
        status: 200,
        headers: {
          "content-type": "TEXT/EVENT-STREAM; charset=utf-8",
          "content-length": String(Buffer.byteLength(sseBody)),
          "content-encoding": "gzip",
        },
      })
    }
    return new Response(JSON.stringify({ id: "resp_turn2", output: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const turn1Response = await createResponses({
    model: "gpt-6.1-sol",
    stream: true,
    input: "Start",
  })
  expect(turn1Response.headers.get("content-length")).toBeNull()
  expect(turn1Response.headers.get("content-encoding")).toBeNull()
  const turn1Text = await turn1Response.text()
  expect(turn1Text).toContain("turn1-added")
  expect(turn1Text).not.toContain("turn1-delta")
  expect(turn1Text).not.toContain("turn1-final")

  const replayHistory: ResponsesApiRequest["input"] = [
    { type: "reasoning", id: "turn1-added", encrypted_content: "cipher-1" },
    { role: "user", content: "Continue" },
  ]

  await createResponses({ model: "gpt-6.1-sol", input: replayHistory })
  expect(sentPayloads[1].input).toEqual([
    { type: "reasoning", id: "turn1-final", encrypted_content: "cipher-1" },
    { role: "user", content: "Continue" },
  ])

  await createResponses({ model: "gpt-6.2-sol", input: replayHistory })
  expect(sentPayloads[2].input).toEqual(replayHistory)

  state.githubToken = "account-b"
  await createResponses({ model: "gpt-6.1-sol", input: replayHistory })
  expect(sentPayloads[3].input).toEqual(replayHistory)
})

test("renews replay ID TTL on repeated hits and tolerates non-array or non-object inputs", async () => {
  let now = 1_000_000
  spyOn(Date, "now").mockImplementation(() => now)

  const body =
    'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"slide-added","type":"reasoning"}}\n\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"slide-final","type":"reasoning"}}\n\n'
  await normalizeResponsesStreamIdentity(
    new Response(body, { headers: { "content-type": "text/event-stream" } }),
    "sliding-ttl",
  ).text()

  const payload: ResponsesApiRequest = {
    model: "test",
    input: [{ type: "reasoning", id: "slide-added" }],
  }

  now += 20 * 60 * 1000
  expect(restoreResponsesReplayIds(payload, "sliding-ttl").input).toEqual([
    { type: "reasoning", id: "slide-final" },
  ])

  now += 20 * 60 * 1000
  expect(restoreResponsesReplayIds(payload, "sliding-ttl").input).toEqual([
    { type: "reasoning", id: "slide-final" },
  ])

  now += 31 * 60 * 1000
  expect(restoreResponsesReplayIds(payload, "sliding-ttl").input).toEqual([
    { type: "reasoning", id: "slide-added" },
  ])

  const undefinedInput = {
    model: "test",
    input: undefined,
  } as unknown as ResponsesApiRequest
  const nullInput = {
    model: "test",
    input: null,
  } as unknown as ResponsesApiRequest
  const mixedInput = {
    model: "test",
    input: [null, "raw", { type: "reasoning", id: "unknown-id" }],
  } as unknown as ResponsesApiRequest

  expect(restoreResponsesReplayIds(undefinedInput, "sliding-ttl")).toBe(
    undefinedInput,
  )
  expect(restoreResponsesReplayIds(nullInput, "sliding-ttl")).toBe(nullInput)
  expect(restoreResponsesReplayIds(mixedInput, "sliding-ttl").input).toEqual([
    null,
    "raw",
    { type: "reasoning", id: "unknown-id" },
  ] as unknown as ResponsesApiRequest["input"])
})

async function readNonEmptyChunks(
  response: Response,
): Promise<Array<Uint8Array>> {
  if (!response.body) throw new Error("Missing body")
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const chunks: Array<Uint8Array> = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    expect(value.byteLength).toBeGreaterThan(0)
    chunks.push(value)
  }
  return chunks
}

test("preserves multi-byte UTF-8 split at passthrough threshold and emits no empty chunks", async () => {
  const paddingLength = 2_000_001
  const chunk1 = new Uint8Array(paddingLength + 2)
  chunk1.fill(0x61, 0, paddingLength)
  chunk1[paddingLength] = 0xe4
  chunk1[paddingLength + 1] = 0xbd
  const suffix = new TextEncoder().encode("ok\n\n")
  const chunk2 = new Uint8Array(1 + suffix.length)
  chunk2[0] = 0xa0
  chunk2.set(suffix, 1)

  const passthroughStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk1)
      controller.enqueue(chunk2)
      controller.close()
    },
  })
  const passthroughResponse = normalizeResponsesStreamIdentity(
    new Response(passthroughStream, {
      headers: { "content-type": "text/event-stream" },
    }),
    "utf8-passthrough",
  )
  const passthroughChunks = await readNonEmptyChunks(passthroughResponse)
  const combined = new Uint8Array(
    passthroughChunks.reduce((sum, part) => sum + part.byteLength, 0),
  )
  let offset = 0
  for (const part of passthroughChunks) {
    combined.set(part, offset)
    offset += part.byteLength
  }
  const decoded = new TextDecoder(undefined, { fatal: true }).decode(combined)
  expect(decoded).not.toContain("\uFFFD")
  expect(decoded.endsWith("你ok\n\n")).toBe(true)
  expect(decoded.length).toBe(paddingLength + "你ok\n\n".length)

  const normalBody =
    'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"n1","type":"reasoning"}}\n\ndata: [DONE]\n\n'
  const normalResponse = normalizeResponsesStreamIdentity(
    new Response(normalBody, {
      headers: { "content-type": "text/event-stream" },
    }),
    "no-empty-flush",
  )
  const normalChunks = await readNonEmptyChunks(normalResponse)
  expect(normalChunks.length).toBeGreaterThan(0)
})

test("records replay IDs from terminal response.completed when done is absent and rejects mismatched item types", async () => {
  const completedOnlyBody = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "completed-added", type: "reasoning", summary: [] },
    },
    {
      type: "response.in_progress",
      response: {
        output: [{ id: "in-progress-id", type: "reasoning" }],
      },
    },
    {
      type: "response.completed",
      response: {
        output: [
          {
            id: "completed-final",
            type: "reasoning",
            encrypted_content: "enc-1",
          },
        ],
      },
    },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("")

  const completedOnlyText = await normalizeResponsesStreamIdentity(
    new Response(completedOnlyBody, {
      headers: { "content-type": "text/event-stream" },
    }),
    "completed-only",
  ).text()

  expect(completedOnlyText).toContain("in-progress-id")
  expect(completedOnlyText).not.toContain("completed-final")
  expect(
    restoreResponsesReplayIds(
      {
        model: "test",
        input: [{ type: "reasoning", id: "completed-added" }],
      },
      "completed-only",
    ).input,
  ).toEqual([{ type: "reasoning", id: "completed-final" }])

  const mismatchedTypeBody = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "reasoning-added", type: "reasoning", summary: [] },
    },
    {
      type: "response.completed",
      response: {
        output: [{ id: "message-final", type: "message" }],
      },
    },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("")

  const mismatchedText = await normalizeResponsesStreamIdentity(
    new Response(mismatchedTypeBody, {
      headers: { "content-type": "text/event-stream" },
    }),
    "type-mismatch",
  ).text()

  expect(mismatchedText).toContain("message-final")
  expect(
    restoreResponsesReplayIds(
      {
        model: "test",
        input: [{ type: "reasoning", id: "reasoning-added" }],
      },
      "type-mismatch",
    ).input,
  ).toEqual([{ type: "reasoning", id: "reasoning-added" }])
})
