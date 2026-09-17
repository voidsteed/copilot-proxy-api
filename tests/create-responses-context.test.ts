import { afterEach, expect, mock, test } from "bun:test"

import type { ResponsesApiRequest } from "~/routes/responses/types"

import { state } from "~/lib/state"
import { createResponses } from "~/services/copilot/create-responses"

/**
 * Context handling for /responses.
 *
 * The proxy forwards client history verbatim by default and lets Copilot
 * enforce its own token limits, so a rejection reflects upstream's real answer
 * instead of a local estimate. Only the ~5 MB Azure Front Door transport cliff
 * is enforced pre-flight, because that one is a verified wire limit.
 */

state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"
state.models = {
  object: "list",
  data: [
    {
      id: "gpt-5.5",
      object: "model",
      name: "GPT 5.5",
      model_picker_enabled: true,
      preview: false,
      vendor: "openai",
      version: "1",
      capabilities: {
        family: "gpt-5.5",
        limits: {
          max_context_window_tokens: 400_000,
          max_output_tokens: 16_000,
          max_prompt_tokens: 272_000,
        },
        object: "model_capabilities",
        supports: {},
        tokenizer: "o200k_base",
        type: "chat",
      },
    },
  ],
}

afterEach(() => {
  mock.restore()
  state.responsesContextTrim = false
})

function bodyToString(body: unknown): string {
  if (typeof body !== "string") {
    throw new TypeError("expected fetch body to be a string")
  }
  return body
}

test("forwards oversized history unchanged by default", async () => {
  // Well over the old token-derived ceiling (924_000) but under the 5 MB
  // transport cliff: previously this was silently rewritten before Copilot
  // ever saw it. The client's conversation must now reach upstream intact.
  const payload: ResponsesApiRequest = {
    model: "gpt-5.5",
    instructions: "Keep the latest task context.",
    input: Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `Turn ${index}\n${"x".repeat(180_000)}`,
    })),
  }

  const fetchMock = mock(
    (_url: string, _opts: RequestInit) =>
      new Response(JSON.stringify({ id: "resp_untrimmed" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await createResponses(payload)
  const sentBody = bodyToString(fetchMock.mock.calls[0][1].body)
  const forwarded = JSON.parse(sentBody) as ResponsesApiRequest

  expect(response.status).toBe(200)
  expect(sentBody.length).toBeGreaterThan(1_135_200)
  expect(JSON.stringify(forwarded.input)).not.toContain(
    "older response input omitted",
  )
  // Every turn survives, including the oldest — the cacheable prefix is intact.
  for (let index = 0; index < 8; index++) {
    expect(JSON.stringify(forwarded.input)).toContain(`Turn ${index}`)
  }
})

test("still enforces the hard transport ceiling without the flag", async () => {
  const payload: ResponsesApiRequest = {
    model: "gpt-5.5",
    input: Array.from({ length: 12 }, (_, index) => ({
      role: "user",
      content: `Huge ${index}\n${"x".repeat(600_000)}`,
    })),
  }

  const fetchMock = mock(
    (_url: string, _opts: RequestInit) =>
      new Response(JSON.stringify({ id: "resp_capped" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch

  await createResponses(payload)
  const sentBody = bodyToString(fetchMock.mock.calls[0][1].body)

  // Azure Front Door rejects above ~5.4 MB regardless of tokens, so this
  // ceiling is a verified wire limit rather than an estimate.
  expect(sentBody.length).toBeLessThanOrEqual(5_000_000)
})

test("surfaces upstream token counts instead of a local estimate", async () => {
  const payload: ResponsesApiRequest = {
    model: "gpt-5.5",
    input: "hello",
    max_output_tokens: 1_000,
  }

  globalThis.fetch = mock(
    () =>
      new Response(
        JSON.stringify({
          error: {
            code: "context_length_exceeded",
            message:
              "This model's maximum context length is 272000 tokens, however your messages resulted in 300000 tokens.",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
  ) as unknown as typeof fetch

  const error = (await createResponses(payload).catch(
    (caught: unknown) => caught,
  )) as { response: Response }

  const body = (await error.response.json()) as {
    error: { message: string; upstream_error?: string }
  }

  expect(error.response.status).toBe(400)
  // Upstream said 300000 > 272000; the proxy must not replace those with its
  // own bytes/4 guess, which Claude Code would then size compaction against.
  expect(body.error.message).toContain("300000")
  expect(body.error.message).toContain("272000")
  expect(body.error.upstream_error).toContain("context_length_exceeded")
})

test("does not treat an unrelated 503 on a large payload as context overflow", async () => {
  const payload: ResponsesApiRequest = {
    model: "gpt-5.5",
    input: [{ role: "user", content: "x".repeat(2_500_000) }],
  }

  globalThis.fetch = mock(
    () =>
      new Response("Service Unavailable: upstream connect error", {
        status: 503,
        statusText: "Service Unavailable",
      }),
  ) as unknown as typeof fetch

  const error = (await createResponses(payload).catch(
    (caught: unknown) => caught,
  )) as { response: Response }

  // A transient outage that happens to coincide with a big payload must stay a
  // 503. Reporting it as prompt-too-long makes the client compact away history
  // to work around what is really a Copilot hiccup.
  expect(error.response.status).toBe(503)
  const body = await error.response.text()
  expect(body).not.toContain("prompt is too long")
})

test("responsesContextTrim opt-in restores token-derived trimming", async () => {
  state.responsesContextTrim = true

  const payload: ResponsesApiRequest = {
    model: "gpt-5.5",
    input: Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `Turn ${index}\n${"x".repeat(180_000)}`,
    })),
  }

  const fetchMock = mock(
    (_url: string, _opts: RequestInit) =>
      new Response(JSON.stringify({ id: "resp_trimmed" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch

  await createResponses(payload)
  const sentBody = bodyToString(fetchMock.mock.calls[0][1].body)

  expect(sentBody.length).toBeLessThanOrEqual(1_135_200)
  expect(sentBody).toContain("older response input omitted")
  // The active request is always preserved, whatever else is dropped.
  expect(sentBody).toContain("Turn 7")
})
