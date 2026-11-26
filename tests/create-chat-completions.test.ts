import { afterEach, expect, mock, spyOn, test } from "bun:test"

import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"

import { HTTPError } from "../src/lib/error"
import { PromptTooLongError } from "../src/lib/prompt-too-long"
import { state } from "../src/lib/state"
import * as utils from "../src/lib/utils"
import { createChatCompletions } from "../src/services/copilot/create-chat-completions"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  state.models = undefined
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

test("does not misclassify a 503 outage on a 2.5 MB payload as PromptTooLongError", async () => {
  spyOn(utils, "sleep").mockResolvedValue(undefined)
  const fetchMock = mock(
    () =>
      new Response("Service Unavailable", {
        status: 503,
        statusText: "Service Unavailable",
      }),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const error = await createChatCompletions({
    messages: [{ role: "user", content: "x".repeat(2_500_000) }],
    model: "gemini-4-neon",
  }).catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(HTTPError)
  expect(error).not.toBeInstanceOf(PromptTooLongError)
  if (error instanceof HTTPError) {
    expect(error.response.status).toBe(503)
  }
})

test("parses upstream-reported token counts from model_max_prompt_tokens_exceeded and Gemini token-limit errors", async () => {
  const upstreamErrorBodies = [
    {
      error: {
        code: "model_max_prompt_tokens_exceeded",
        message: "prompt token count of 1050000 exceeds the limit of 983040",
      },
    },
    {
      error: {
        message:
          "input token count (1050000) exceeds the maximum number of tokens allowed (983040)",
      },
    },
  ]

  for (const body of upstreamErrorBodies) {
    globalThis.fetch = mock(() =>
      Response.json(body, { status: 400 }),
    ) as unknown as typeof fetch

    const error = await createChatCompletions({
      messages: [{ role: "user", content: "hello" }],
      model: "gemini-4-neon",
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(PromptTooLongError)
    if (error instanceof PromptTooLongError) {
      expect(error.estimatedTokens).toBe(1_050_000)
      expect(error.modelLimit).toBe(983_040)
    }
  }
})

test("enforces 5 MB UTF-8 wire ceiling before fetch and omits Copilot-Vision-Request when all images are stripped", async () => {
  const fetchMock = mockSuccessfulFetch()

  await createChatCompletions({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "漢".repeat(1_500_000) },
          {
            type: "image_url",
            image_url: {
              url: `data:image/png;base64,${"A".repeat(800_000)}`,
            },
          },
        ],
      },
    ],
    model: "gemini-4-neon",
  })

  expect(fetchMock).toHaveBeenCalledTimes(1)
  const callInit = fetchMock.mock.calls[0][1] as {
    body: string
    headers: Record<string, string>
  }
  expect(Buffer.byteLength(callInit.body, "utf8")).toBeLessThanOrEqual(
    5_000_000,
  )

  const sentPayload = JSON.parse(callInit.body) as ChatCompletionsPayload
  const hasRemainingImage = sentPayload.messages.some(
    (msg) =>
      Array.isArray(msg.content)
      && msg.content.some((part) => part.type === "image_url"),
  )
  expect(hasRemainingImage).toBe(false)
  expect(new Headers(callInit.headers).get("copilot-vision-request")).toBeNull()
})

test("does not misclassify a 504 Gateway Timeout mentioning operation timed out on a 2.5 MB payload", async () => {
  spyOn(utils, "sleep").mockResolvedValue(undefined)
  const fetchMock = mock(
    () =>
      new Response("Gateway Timeout: operation timed out", {
        status: 504,
        statusText: "Gateway Timeout",
      }),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const error = await createChatCompletions({
    messages: [{ role: "user", content: "x".repeat(2_500_000) }],
    model: "gemini-4-neon",
  }).catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(HTTPError)
  expect(error).not.toBeInstanceOf(PromptTooLongError)
  if (error instanceof HTTPError) {
    expect(error.response.status).toBe(504)
  }
})

test("clamps fallback PromptTooLongError estimatedTokens above modelLimit on HTTP 413", async () => {
  state.models = {
    object: "list",
    data: [
      {
        id: "gemini-4-neon",
        name: "Gemini 4 Neon",
        vendor: "Google",
        object: "model",
        version: "1",
        preview: true,
        model_picker_enabled: true,
        supported_endpoints: ["/chat/completions"],
        capabilities: {
          family: "gemini-4-neon",
          type: "chat",
          object: "model_capabilities",
          tokenizer: "o200k_base",
          limits: { max_prompt_tokens: 983_040, max_output_tokens: 65_536 },
          supports: { vision: true, streaming: true, tool_calls: true },
        },
      },
    ],
  }
  globalThis.fetch = mock(
    () =>
      new Response("Payload Too Large", {
        status: 413,
        statusText: "Payload Too Large",
      }),
  ) as unknown as typeof fetch

  const error = await createChatCompletions({
    messages: [{ role: "user", content: "x".repeat(2_500_000) }],
    model: "gemini-4-neon",
  }).catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(PromptTooLongError)
  if (error instanceof PromptTooLongError) {
    expect(error.tokenCountSource).toBe("estimated")
    expect(error.modelLimit).toBe(983_040)
    expect(error.estimatedTokens).toBeGreaterThan(error.modelLimit)
  }
})
