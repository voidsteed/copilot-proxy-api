import { fetch as builtinFetch } from "bun"
import { afterEach, expect, mock, test } from "bun:test"

import { state } from "~/lib/state"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"

const previousToken = state.copilotToken
let restoreFetch: (() => void) | undefined

afterEach(() => {
  restoreFetch?.()
  restoreFetch = undefined
  state.copilotToken = previousToken
})

function setFetch(implementation: typeof fetch): void {
  const previousFetch = globalThis.fetch
  globalThis.fetch = implementation
  restoreFetch = () => {
    globalThis.fetch = previousFetch
  }
}

async function expectFailure(
  operation: Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await operation
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    if (!(error instanceof Error)) throw error
    expect(error.message).toContain(message)
    return
  }
  throw new Error("Expected request failure")
}

function useResponse(body: ReadableStream<Uint8Array>): void {
  state.copilotToken = "upstream-fixture-token"
  const fetchMock = mock(() =>
    Promise.resolve(
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
    ),
  )
  setFetch(Object.assign(fetchMock, { preconnect: builtinFetch.preconnect }))
}

test("pre-aborted chat never contacts upstream", async () => {
  state.copilotToken = "upstream-fixture-token"
  const fetchMock = mock(() => Promise.reject(new Error("fetch must not run")))
  setFetch(Object.assign(fetchMock, { preconnect: builtinFetch.preconnect }))
  const abort = new AbortController()
  abort.abort(new Error("cancel before fetch"))
  await expectFailure(
    createChatCompletions({ model: "fixture", messages: [] }, abort.signal),
    "cancel before fetch",
  )
  expect(fetchMock).not.toHaveBeenCalled()
})

test("chat uses actual fetch with its abort signal and upstream credentials", async () => {
  state.copilotToken = "upstream-fixture-token"
  let upstreamHeaders = new Headers()
  let upstreamBody = ""
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      upstreamHeaders = request.headers
      upstreamBody = await request.text()
      return Response.json({ id: "actual-fetch", choices: [] })
    },
  })
  const fetchMock = mock(
    (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      builtinFetch(server.url, init),
  )
  setFetch(Object.assign(fetchMock, { preconnect: builtinFetch.preconnect }))
  const abort = new AbortController()
  try {
    const result = await createChatCompletions(
      { model: "fixture", messages: [{ role: "user", content: "hello" }] },
      abort.signal,
    )
    expect(result).toMatchObject({ id: "actual-fetch" })
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(abort.signal)
    expect(upstreamHeaders.get("authorization")).toBe(
      "Bearer upstream-fixture-token",
    )
    expect(upstreamHeaders.has("x-goog-api-key")).toBe(false)
    expect(JSON.parse(upstreamBody)).toMatchObject({ model: "fixture" })
  } finally {
    await server.stop(true)
  }
})

test("late abort settles pending SSE read and cancels upstream body", async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"first":true}\n\n'))
    },
    cancel() {
      cancelled = true
    },
  })
  useResponse(body)
  const abort = new AbortController()
  const result = await createChatCompletions(
    { model: "fixture", messages: [], stream: true },
    abort.signal,
  )
  if (!(Symbol.asyncIterator in result)) throw new Error("Expected SSE")
  expect((await result.next()).value).toEqual({ data: '{"first":true}' })
  const pending = result.next()
  abort.abort(new Error("cancel pending read"))
  await expectFailure(pending, "cancel pending read")
  expect(cancelled).toBe(true)
  expect(body.locked).toBe(false)
})

test("consumer early return cancels the real SSE source reader", async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"first":true}\n\n'))
    },
    cancel() {
      cancelled = true
    },
  })
  useResponse(body)
  const result = await createChatCompletions({
    model: "fixture",
    messages: [],
    stream: true,
  })
  if (!(Symbol.asyncIterator in result)) throw new Error("Expected SSE")
  for await (const event of result) {
    expect(event.data).toBe('{"first":true}')
    break
  }
  expect(cancelled).toBe(true)
  expect(body.locked).toBe(false)
})

test("abort after headers cancels body before an SSE consumer begins iteration", async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true
    },
  })
  useResponse(body)
  const abort = new AbortController()
  const result = await createChatCompletions(
    { model: "fixture", messages: [], stream: true },
    abort.signal,
  )
  abort.abort(new Error("cancel before iteration"))
  if (!(Symbol.asyncIterator in result)) throw new Error("Expected SSE")
  await expectFailure(result.next(), "cancel before iteration")
  expect(cancelled).toBe(true)
  expect(body.locked).toBe(false)
})

test("normal SSE completion releases the upstream reader", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode("data: first\n\ndata: [DONE]\n\n"),
      )
      controller.close()
    },
  })
  useResponse(body)
  const result = await createChatCompletions({
    model: "fixture",
    messages: [],
    stream: true,
  })
  if (!(Symbol.asyncIterator in result)) throw new Error("Expected SSE")
  const values: Array<string | undefined> = []
  for await (const event of result) values.push(event.data)
  expect(values).toEqual(["first", "[DONE]"])
  expect(body.locked).toBe(false)
})

test("return before the first SSE event releases the source reader", async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true
    },
  })
  useResponse(body)
  const result = await createChatCompletions({
    model: "fixture",
    messages: [],
    stream: true,
  })
  if (!(Symbol.asyncIterator in result)) throw new Error("Expected SSE")
  await result.return()
  expect(cancelled).toBe(true)
  expect(body.locked).toBe(false)
})
