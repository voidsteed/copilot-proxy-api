import { afterEach, test, expect, mock } from "bun:test"

import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"

import { state } from "../src/lib/state"
import { createChatCompletions } from "../src/services/copilot/create-chat-completions"

afterEach(() => {
  mock.restore()
})

// Mock state
state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

function mockSuccessfulFetch() {
  const fetchMock = mock(
    (
      _url: string,
      opts: { body?: unknown; headers: Record<string, string> },
    ) => {
      return {
        ok: true,
        json: () => ({ id: "123", object: "chat.completion", choices: [] }),
        headers: opts.headers,
      }
    },
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

test("sets X-Initiator to agent if tool/assistant present", async () => {
  const fetchMock = mockSuccessfulFetch()
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "tool", content: "tool call" },
    ],
    model: "gpt-test",
  }
  await createChatCompletions(payload)
  expect(fetchMock).toHaveBeenCalled()
  const headers = (
    fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["X-Initiator"]).toBe("agent")
})

test("sets X-Initiator to user if only user present", async () => {
  const fetchMock = mockSuccessfulFetch()
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "user", content: "hello again" },
    ],
    model: "gpt-test",
  }
  await createChatCompletions(payload)
  expect(fetchMock).toHaveBeenCalled()
  const headers = (
    fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["X-Initiator"]).toBe("user")
})

test("uses max_completion_tokens for GPT-5 models", async () => {
  const fetchMock = mockSuccessfulFetch()

  await createChatCompletions({
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-5.4",
    max_tokens: 123,
  })

  const body = JSON.parse(
    fetchMock.mock.calls[0][1].body as string,
  ) as ChatCompletionsPayload
  expect(body.max_completion_tokens).toBe(123)
  expect(body).not.toHaveProperty("max_tokens")
})

test("keeps max_tokens for legacy chat completion models", async () => {
  const fetchMock = mockSuccessfulFetch()

  await createChatCompletions({
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-4o",
    max_tokens: 123,
  })

  const body = JSON.parse(
    fetchMock.mock.calls[0][1].body as string,
  ) as ChatCompletionsPayload
  expect(body.max_tokens).toBe(123)
  expect(body).not.toHaveProperty("max_completion_tokens")
})

test("large upstream timeout becomes prompt-too-long error", async () => {
  const timeoutFetchMock = mock(() => {
    throw new Error("The operation timed out.")
  })
  globalThis.fetch = timeoutFetchMock as unknown as typeof fetch

  try {
    await createChatCompletions({
      messages: [{ role: "user", content: "x".repeat(2_000_001) }],
      model: "gpt-test",
      max_tokens: 1,
    })
  } catch (error) {
    const response = (error as { response: Response }).response
    const body = (await response.json()) as {
      error: { type: string; message: string }
    }
    expect(body.error.type).toBe("invalid_request_error")
    expect(body.error.message).toContain("prompt is too long")
  }
  expect(timeoutFetchMock).toHaveBeenCalledTimes(1)
})

test("retries transient upstream 499 responses", async () => {
  const fetchMock = mock(() => {
    if (fetchMock.mock.calls.length === 1) {
      return new Response(null, { status: 499, statusText: "status code 499" })
    }
    return new Response(
      JSON.stringify({ id: "123", object: "chat.completion", choices: [] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await createChatCompletions({
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-test",
  })

  expect(response).toMatchObject({ id: "123" })
  expect(fetchMock).toHaveBeenCalledTimes(2)
})
