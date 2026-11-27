import { fetch as builtinFetch } from "bun"
import { afterEach, expect, test } from "bun:test"

import type { CompletedRequestSummary } from "~/lib/request-log"
import type { Model } from "~/services/copilot/get-models"

import {
  createDesktopProxy,
  type DesktopProxyAuthentication,
} from "~/desktop-proxy"
import { state } from "~/lib/state"

const originalModels = state.models
const originalCopilotToken = state.copilotToken
const originalRateLimitSeconds = state.rateLimitSeconds
let restoreFetch: (() => void) | undefined

const geminiModel: Model = {
  id: "gemini-fixture",
  name: "Gemini Fixture",
  vendor: "Google",
  object: "model",
  version: "1",
  preview: false,
  model_picker_enabled: true,
  supported_endpoints: ["/chat/completions"],
  capabilities: {
    family: "gemini-fixture",
    type: "chat",
    object: "model_capabilities",
    tokenizer: "o200k_base",
    limits: { max_output_tokens: 8192 },
    supports: { streaming: true, tool_calls: true },
  },
}

const codexModel: Model = {
  id: "gpt-5",
  name: "GPT-5",
  vendor: "OpenAI",
  object: "model",
  version: "1",
  preview: false,
  model_picker_enabled: true,
  supported_endpoints: ["/responses"],
  capabilities: {
    family: "gpt-5",
    type: "chat",
    object: "model_capabilities",
    tokenizer: "o200k_base",
    limits: { max_context_window_tokens: 200_000, max_prompt_tokens: 180_000 },
    supports: { reasoning_effort: ["low", "medium", "high"] },
  },
}

afterEach(() => {
  restoreFetch?.()
  restoreFetch = undefined
  state.models = originalModels
  state.copilotToken = originalCopilotToken
  state.rateLimitSeconds = originalRateLimitSeconds
})

function gateway(authentication?: DesktopProxyAuthentication) {
  const completed: Array<CompletedRequestSummary> = []
  const app = createDesktopProxy({
    port: 34567,
    authentication: authentication ?? {
      kind: "keyed",
      keys: ["local-private"],
    },
    onComplete: (summary) => completed.push(summary),
  })
  return { app, completed }
}

function seedModelsAndUpstream(responder: (init?: RequestInit) => Response) {
  state.models = { object: "list", data: [geminiModel, codexModel] }
  state.copilotToken = "upstream-fixture-token"
  state.rateLimitSeconds = undefined
  const previousFetch = globalThis.fetch
  globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (url.endsWith("/models")) {
        return Promise.resolve(
          Response.json({ object: "list", data: [geminiModel, codexModel] }),
        )
      }
      return Promise.resolve(responder(init))
    },
    { preconnect: builtinFetch.preconnect },
  )
  restoreFetch = () => {
    globalThis.fetch = previousFetch
  }
}

test("enforces loopback host, rejects Origin, and serves root service descriptor", async () => {
  const { app } = gateway()
  const ok = await app.request("http://127.0.0.1:34567/", {
    headers: { host: "127.0.0.1:34567", authorization: "Bearer local-private" },
  })
  expect(ok.status).toBe(200)
  expect(await ok.json()).toEqual({ service: "Copilot Proxy" })

  const badHost = await app.request("http://example.com/", {
    headers: { host: "example.com", authorization: "Bearer local-private" },
  })
  expect(badHost.status).toBe(403)

  const withOrigin = await app.request("http://127.0.0.1:34567/", {
    headers: {
      host: "127.0.0.1:34567",
      origin: "https://evil.example",
      authorization: "Bearer local-private",
    },
  })
  expect(withOrigin.status).toBe(403)

  expect(() =>
    createDesktopProxy({
      port: 34567,
      authentication: { kind: "keyed", keys: [] },
      onComplete: () => undefined,
    }),
  ).toThrow("API key")

  const openGateway = gateway({ kind: "none" })
  const openResponse = await openGateway.app.request("http://[::1]:34567/", {
    headers: { host: "[::1]:34567" },
  })
  expect(openResponse.status).toBe(200)
})

test.each([
  "/v1beta/models/gemini-fixture:generateContent",
  "/v1/models/gemini-fixture:generateContent",
])(
  "native Google header auth reaches the mounted Google validation boundary on %s",
  async (generationPath) => {
    const { app, completed } = gateway()
    const response = await app.request(
      `http://127.0.0.1:34567${generationPath}?key=query-private`,
      {
        method: "POST",
        headers: { host: "127.0.0.1:34567", "x-goog-api-key": "local-private" },
        body: "invalid JSON",
      },
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: 400, status: "INVALID_ARGUMENT" },
    })
    expect(completed).toHaveLength(1)
    expect(completed[0]?.outcome).toBe("failed")
    const retained = JSON.stringify(completed)
    for (const secret of ["local-private", "query-private", "x-goog-api-key"])
      expect(retained).not.toContain(secret)
  },
)

test.each([
  "/v1beta/models/gemini-fixture:generateContent",
  "/v1/models/gemini-fixture:generateContent",
])(
  "native Google auth preserves all-present-valid policy and rejects query-only credentials on %s",
  async (generationPath) => {
    const { app } = gateway()
    const credentialSets: Array<Record<string, string>> = [
      {},
      { "x-goog-api-key": "wrong" },
      { "x-goog-api-key": "local-private", authorization: "Bearer wrong" },
      { "x-goog-api-key": "wrong", authorization: "Bearer local-private" },
      { "x-goog-api-key": "local-private", "x-api-key": "wrong" },
    ]
    for (const headers of credentialSets) {
      const response = await app.request(
        `http://127.0.0.1:34567${generationPath}?key=local-private`,
        {
          method: "POST",
          headers: { host: "127.0.0.1:34567", ...headers },
          body: "invalid JSON",
        },
      )
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({
        error: {
          code: 401,
          status: "UNAUTHENTICATED",
          message: "Missing or invalid gateway key",
        },
      })
    }
  },
)

test("serves Gemini discovery, generation, and SSE streaming on both /v1/models and /v1beta/models", async () => {
  seedModelsAndUpstream((init) => {
    const rawBody = typeof init?.body === "string" ? init.body : "{}"
    const parsed = JSON.parse(rawBody) as {
      stream?: boolean
    }
    if (parsed.stream) {
      return new Response(
        [
          `data: ${JSON.stringify({
            id: "cmpl_1",
            object: "chat.completion.chunk",
            created: 1,
            model: "gemini-fixture",
            choices: [
              {
                index: 0,
                delta: { content: "hi" },
                finish_reason: null,
                logprobs: null,
              },
            ],
          })}`,
          `data: ${JSON.stringify({
            id: "cmpl_1",
            object: "chat.completion.chunk",
            created: 1,
            model: "gemini-fixture",
            choices: [
              { index: 0, delta: {}, finish_reason: "stop", logprobs: null },
            ],
            usage: {
              prompt_tokens: 11,
              completion_tokens: 3,
              total_tokens: 14,
            },
          })}`,
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    return Response.json({
      id: "cmpl_1",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hello" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
    })
  })

  const { app, completed } = gateway()
  const googleHeaders = {
    host: "127.0.0.1:34567",
    "x-goog-api-key": "local-private",
  }

  for (const prefix of ["/v1/models", "/v1beta/models"]) {
    const listResponse = await app.request(`http://127.0.0.1:34567${prefix}`, {
      headers: googleHeaders,
    })
    expect(listResponse.status).toBe(200)
    expect(await listResponse.json()).toMatchObject({
      models: [{ name: "models/gemini-fixture" }],
    })

    const getResponse = await app.request(
      `http://127.0.0.1:34567${prefix}/gemini-fixture`,
      { headers: googleHeaders },
    )
    expect(getResponse.status).toBe(200)
    expect(await getResponse.json()).toMatchObject({
      name: "models/gemini-fixture",
    })

    const generateResponse = await app.request(
      `http://127.0.0.1:34567${prefix}/gemini-fixture:generateContent`,
      {
        method: "POST",
        headers: { ...googleHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hello" }] }],
        }),
      },
    )
    expect(generateResponse.status).toBe(200)
    expect(await generateResponse.json()).toMatchObject({
      candidates: [{ content: { parts: [{ text: "hello" }] } }],
    })

    const streamResponse = await app.request(
      `http://127.0.0.1:34567${prefix}/gemini-fixture:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: { ...googleHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hello" }] }],
        }),
      },
    )
    expect(streamResponse.status).toBe(200)
    expect(await streamResponse.text()).toContain('"finishReason":"STOP"')
  }

  const openAiModels = await app.request("http://127.0.0.1:34567/v1/models", {
    headers: { host: "127.0.0.1:34567", authorization: "Bearer local-private" },
  })
  expect(openAiModels.status).toBe(200)
  expect(await openAiModels.json()).toMatchObject({ object: "list" })

  const unauthOpenAiModels = await app.request(
    "http://127.0.0.1:34567/v1/models",
    { headers: { host: "127.0.0.1:34567" } },
  )
  expect(unauthOpenAiModels.status).toBe(401)
  expect(await unauthOpenAiModels.json()).toEqual({
    error: {
      message: "Missing or invalid gateway key",
      type: "authentication_error",
    },
  })

  const badGoogleModels = await app.request(
    "http://127.0.0.1:34567/v1/models",
    { headers: { host: "127.0.0.1:34567", "x-goog-api-key": "wrong" } },
  )
  expect(badGoogleModels.status).toBe(401)
  expect(await badGoogleModels.json()).toEqual({
    error: {
      code: 401,
      status: "UNAUTHENTICATED",
      message: "Missing or invalid gateway key",
    },
  })

  expect(
    completed.filter((entry) => entry.path.endsWith(":generateContent")),
  ).toMatchObject([
    {
      path: "/v1/models/gemini-fixture:generateContent",
      outcome: "completed",
      inputTokens: 9,
      outputTokens: 2,
    },
    {
      path: "/v1beta/models/gemini-fixture:generateContent",
      outcome: "completed",
      inputTokens: 9,
      outputTokens: 2,
    },
  ])
  expect(
    completed.filter((entry) => entry.path.endsWith(":streamGenerateContent")),
  ).toMatchObject([
    {
      path: "/v1/models/gemini-fixture:streamGenerateContent",
      outcome: "completed",
      inputTokens: 11,
      outputTokens: 3,
    },
    {
      path: "/v1beta/models/gemini-fixture:streamGenerateContent",
      outcome: "completed",
      inputTokens: 11,
      outputTokens: 3,
    },
  ])
})

test("rejects x-goog-api-key on non-Gemini paths and enforces all-present-valid across headers", async () => {
  state.models = { object: "list", data: [geminiModel, codexModel] }
  const { app } = gateway()
  const nonGeminiRequests: Array<{ path: string; method: string }> = [
    { path: "/v1/chat/completions", method: "POST" },
    { path: "/v1/models/gpt-5/codex-config", method: "GET" },
    { path: "/models", method: "GET" },
  ]
  const rejectedHeaders: Array<Record<string, string>> = [
    { "x-goog-api-key": "local-private" },
    { authorization: "Bearer local-private", "x-goog-api-key": "wrong" },
    { authorization: "Bearer wrong", "x-goog-api-key": "local-private" },
    { "x-api-key": "local-private", "x-goog-api-key": "wrong" },
  ]
  for (const { path, method } of nonGeminiRequests) {
    for (const headers of rejectedHeaders) {
      const response = await app.request(`http://127.0.0.1:34567${path}`, {
        method,
        headers: { host: "127.0.0.1:34567", ...headers },
      })
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({
        error: {
          message: "Missing or invalid gateway key",
          type: "authentication_error",
        },
      })
    }
  }

  const validCodexConfig = await app.request(
    "http://127.0.0.1:34567/v1/models/gpt-5/codex-config",
    {
      headers: {
        host: "127.0.0.1:34567",
        authorization: "Bearer local-private",
      },
    },
  )
  expect(validCodexConfig.status).toBe(200)
})
