import { afterEach, beforeEach, expect, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import { state } from "~/lib/state"
import { server } from "~/server"

const originalFetch = globalThis.fetch
const model: Model = {
  id: "gemini-4-carbon",
  name: "Gemini 4 Carbon",
  vendor: "Google",
  object: "model",
  version: "1",
  preview: true,
  model_picker_enabled: true,
  supported_endpoints: ["/chat/completions"],
  capabilities: {
    family: "gemini-4-carbon",
    type: "chat",
    object: "model_capabilities",
    tokenizer: "o200k_base",
    limits: { max_output_tokens: 65536 },
    supports: {
      vision: true,
      streaming: true,
      tool_calls: true,
      reasoning_effort: ["low", "medium", "high"],
    },
  },
}

const textRequest = { contents: [{ role: "user", parts: [{ text: "hello" }] }] }
let sent: Array<unknown> = []
let responseBody: object = {}

function generate(body: unknown) {
  return server.request(`/v1beta/models/${model.id}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  sent = []
  responseBody = {
    id: "reply",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hello" },
        finish_reason: "stop",
      },
    ],
  }
  state.models = { object: "list", data: [model] }
  state.copilotToken = "fake-upstream"
  state.githubToken = undefined
  state.localApiKeys = []
  state.rateLimitSeconds = undefined
  globalThis.fetch = Object.assign(
    (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.body && typeof init.body === "string")
        sent.push(JSON.parse(init.body))
      return Promise.resolve(Response.json(responseBody))
    },
    { preconnect: originalFetch.preconnect },
  )
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.models = undefined
  state.githubToken = undefined
  state.localApiKeys = []
  state.rateLimitSeconds = undefined
})

test("nullable upstream fields and reasoning_tokens translate cleanly", async () => {
  responseBody = {
    id: null,
    model: null,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hello", tool_calls: null },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 20,
      completion_tokens: 12,
      total_tokens: 32,
      prompt_tokens_details: null,
      completion_tokens_details: { reasoning_tokens: 7 },
    },
  }
  const withReasoning = await generate(textRequest)
  expect(withReasoning.status).toBe(200)
  expect(await withReasoning.json()).toEqual({
    candidates: [
      {
        index: 0,
        content: { role: "model", parts: [{ text: "hello" }] },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: 20,
      candidatesTokenCount: 12,
      totalTokenCount: 32,
      thoughtsTokenCount: 7,
    },
  })

  responseBody = {
    id: "reply",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "ok", tool_calls: null },
        finish_reason: "stop",
      },
    ],
    usage: null,
  }
  const withNullUsage = await generate(textRequest)
  expect(withNullUsage.status).toBe(200)
  expect(await withNullUsage.json()).not.toHaveProperty("usageMetadata")
})

test("context overflow returns a safe Gemini token-limit error without leaking upstream text", async () => {
  globalThis.fetch = Object.assign(
    () =>
      Promise.resolve(
        Response.json(
          { error: { message: "context_length_exceeded: secret user text" } },
          { status: 400 },
        ),
      ),
    { preconnect: originalFetch.preconnect },
  )
  const response = await generate(textRequest)
  expect(response.status).toBe(400)
  const body = (await response.json()) as {
    error: { code: number; status: string; message: string }
  }
  expect(body.error.code).toBe(400)
  expect(body.error.status).toBe("INVALID_ARGUMENT")
  expect(body.error.message).toContain("input token count")
  expect(body.error.message).toContain("exceeds the maximum")
  expect(body.error.message).not.toContain("secret user text")
})

test("fn.parameters allows lowercase JSON Schema containing uppercase enum values and rejects uppercase types", async () => {
  const validResponse = await generate({
    ...textRequest,
    tools: [
      {
        functionDeclarations: [
          {
            name: "filter_values",
            parameters: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: ["STRING", "NUMBER", "NULL"],
                  description: 'Use "NULL" for empty values',
                },
              },
            },
          },
        ],
      },
    ],
  })
  expect(validResponse.status).toBe(200)
  expect(sent).toHaveLength(1)

  for (const parameters of [
    { type: "OBJECT", properties: { name: { type: "STRING" } } },
    { type: "object", properties: { name: { type: "STRING" } } },
    {
      type: "object",
      properties: { list: { type: "array", items: { type: "INTEGER" } } },
    },
  ]) {
    const rejected = await generate({
      ...textRequest,
      tools: [{ functionDeclarations: [{ name: "bad_schema", parameters }] }],
    })
    expect(rejected.status).toBe(400)
  }
  expect(sent).toHaveLength(1)
})

test("multimodal functionResponse parts and webp inlineData forward images, reject gif, and enforce vision", async () => {
  const call = { id: "call-img-1", name: "read_file", args: { Path: "a.png" } }
  const multimodalRequest = {
    contents: [
      {
        role: "user",
        parts: [
          { text: "Inspect" },
          {
            inlineData: {
              mimeType: "image/webp",
              data: "UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=",
              displayName: "pixel.webp",
            },
          },
        ],
      },
      { role: "model", parts: [{ functionCall: call }] },
      {
        role: "model",
        parts: [
          {
            functionResponse: {
              id: call.id,
              name: call.name,
              response: { ok: true },
              parts: [
                {
                  inlineData: {
                    mimeType: "image/png",
                    data: "aGVsbG8=",
                    displayName: "shot.png",
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  }
  const ok = await generate(multimodalRequest)
  expect(ok.status).toBe(200)
  expect(sent[0]).toMatchObject({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect" },
          {
            type: "image_url",
            image_url: {
              url: "data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=",
            },
          },
        ],
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: call.id }],
      },
      {
        role: "tool",
        tool_call_id: call.id,
        content: '{"ok":true}',
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Attached image(s) returned by the preceding tool call(s):",
          },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,aGVsbG8=" },
          },
        ],
      },
    ],
  })

  const gifRejected = await generate({
    contents: [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType: "image/gif",
              data: "R0lGODlhAQABAAAAACw=",
            },
          },
        ],
      },
    ],
  })
  expect(gifRejected.status).toBe(400)

  state.models = {
    object: "list",
    data: [
      {
        ...model,
        capabilities: {
          ...model.capabilities,
          supports: { ...model.capabilities.supports, vision: false },
        },
      },
    ],
  }
  const noVision = await generate({
    contents: [
      { role: "user", parts: [{ text: "Read image" }] },
      multimodalRequest.contents[1],
      multimodalRequest.contents[2],
    ],
  })
  expect(noVision.status).toBe(400)
})

function buildMinimalTextPdf(text: string): string {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ]
  let pdf = "%PDF-1.4\n"
  const offsets: Array<number> = [0]
  for (const obj of objects) {
    offsets.push(pdf.length)
    pdf += obj
  }
  const xrefOffset = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf, "utf8").toString("base64")
}

test("PDF inlineData in user and functionResponse parts extracts text without needing vision", async () => {
  state.models = {
    object: "list",
    data: [
      {
        ...model,
        capabilities: {
          ...model.capabilities,
          supports: { ...model.capabilities.supports, vision: false },
        },
      },
    ],
  }
  const pdfBase64 = buildMinimalTextPdf("Hello Gemini PDF")
  const call = { id: "call-pdf-1", name: "read_file", args: { Path: "a.pdf" } }
  const ok = await generate({
    contents: [
      {
        role: "user",
        parts: [
          { text: "Read this" },
          {
            inlineData: {
              mimeType: "application/pdf",
              data: pdfBase64,
              displayName: "spec.pdf",
            },
          },
        ],
      },
      { role: "model", parts: [{ functionCall: call }] },
      {
        role: "model",
        parts: [
          {
            functionResponse: {
              id: call.id,
              name: call.name,
              response: {
                output: "Showing binary file of type application/pdf",
              },
              parts: [
                {
                  inlineData: {
                    mimeType: "application/pdf",
                    data: pdfBase64,
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  })
  expect(ok.status).toBe(200)
  const payload = sent[0] as {
    messages: Array<{ role: string; content: unknown }>
  }
  expect(payload.messages[0]?.role).toBe("user")
  expect(String(payload.messages[0]?.content)).toContain("Document: spec.pdf")
  expect(String(payload.messages[0]?.content)).toContain("Hello Gemini PDF")
  expect(payload.messages[2]?.role).toBe("tool")
  expect(String(payload.messages[2]?.content)).toContain("Hello Gemini PDF")

  const badPdf = await generate({
    contents: [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType: "application/pdf",
              data: Buffer.from("not a pdf").toString("base64"),
            },
          },
        ],
      },
    ],
  })
  expect(badPdf.status).toBe(400)
})

test("thinkingBudget -1 is accepted as dynamic thinking while 0, positive budgets, and server-side tools fail clearly", async () => {
  const dynamic = await generate({
    ...textRequest,
    generationConfig: {
      thinkingConfig: { includeThoughts: true, thinkingBudget: -1 },
    },
  })
  expect(dynamic.status).toBe(200)
  expect(sent[0]).not.toHaveProperty("reasoning_effort")

  for (const thinkingConfig of [
    { thinkingBudget: 0 },
    { thinkingBudget: 10 },
    { thinkingLevel: "LOW", thinkingBudget: -1 },
  ]) {
    const res = await generate({
      ...textRequest,
      generationConfig: { thinkingConfig },
    })
    expect(res.status).toBe(400)
  }

  const searchRes = await generate({
    ...textRequest,
    tools: [{ googleSearch: {} }],
  })
  expect(searchRes.status).toBe(400)
  expect(await searchRes.json()).toEqual({
    error: {
      code: 400,
      status: "INVALID_ARGUMENT",
      message:
        "Server-side Gemini tools (googleSearch) are not supported by Copilot",
    },
  })
})

test("Gemini v1 routes work without beta while preserving OpenAI and Codex /v1/models", async () => {
  const openAiList = await server.request("/v1/models")
  expect(openAiList.status).toBe(200)
  expect(await openAiList.json()).toMatchObject({
    object: "list",
    data: [{ id: model.id }],
  })

  const codexList = await server.request("/v1/models?client_version=0.146.0")
  expect(codexList.status).toBe(200)
  expect(await codexList.json()).toEqual({ models: [] })

  const codexConfig = await server.request(
    `/v1/models/${model.id}/codex-config`,
  )
  expect(codexConfig.status).toBe(400)

  const geminiGet = await server.request(`/v1/models/${model.id}`)
  expect(geminiGet.status).toBe(200)
  expect(await geminiGet.json()).toMatchObject({
    name: `models/${model.id}`,
  })

  const geminiGenerate = await server.request(
    `/v1/models/${model.id}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(textRequest),
    },
  )
  expect(geminiGenerate.status).toBe(200)
  expect(await geminiGenerate.json()).toMatchObject({
    candidates: [{ content: { role: "model", parts: [{ text: "hello" }] } }],
  })

  globalThis.fetch = Object.assign(
    () => Promise.resolve(Response.json({ object: "list", data: [model] })),
    { preconnect: originalFetch.preconnect },
  )
  const geminiList = await server.request("/v1/models", {
    headers: { "x-goog-api-key": "any-key" },
  })
  expect(geminiList.status).toBe(200)
  expect(await geminiList.json()).toMatchObject({
    models: [{ name: `models/${model.id}` }],
  })
})

test("gemini-3.1-flash-lite-preview aliases to gemini-3.8-flash with MINIMAL mapped to low", async () => {
  const flash: Model = {
    ...model,
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    capabilities: {
      ...model.capabilities,
      family: "gemini-3.8-flash",
    },
  }
  state.models = { object: "list", data: [model, flash] }

  const aliased = await server.request(
    "/v1beta/models/gemini-3.1-flash-lite-preview:generateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...textRequest,
        generationConfig: {
          thinkingConfig: { includeThoughts: true, thinkingLevel: "MINIMAL" },
        },
      }),
    },
  )
  expect(aliased.status).toBe(200)
  expect(sent[0]).toMatchObject({
    model: "gemini-3.8-flash",
    reasoning_effort: "low",
  })

  const nativeFlashLite: Model = {
    ...flash,
    id: "gemini-3.1-flash-lite-preview",
    name: "Gemini 3.1 Flash Lite",
  }
  state.models = { object: "list", data: [flash, nativeFlashLite] }
  sent = []

  const nativeRes = await server.request(
    "/v1beta/models/gemini-3.1-flash-lite-preview:generateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(textRequest),
    },
  )
  expect(nativeRes.status).toBe(200)
  expect(sent[0]).toMatchObject({ model: "gemini-3.1-flash-lite-preview" })
})

test("enforces Copilot max_prompt_images and max_prompt_image_size by keeping newest valid images", async () => {
  const visionLimitedModel: Model = {
    ...model,
    capabilities: {
      ...model.capabilities,
      limits: {
        ...model.capabilities.limits,
        vision: {
          max_prompt_images: 10,
          max_prompt_image_size: 100,
        },
      },
    },
  }
  state.models = { object: "list", data: [visionLimitedModel] }

  const makePng = (tag: number) => Buffer.from(`img-${tag}`).toString("base64")
  const oversizedPng = Buffer.alloc(120, 65).toString("base64")
  const calls = Array.from({ length: 15 }, (_, index) => ({
    id: `call-img-${index}`,
    name: "read_file",
    args: { Path: `shot-${index}.png` },
  }))

  const response = await generate({
    contents: [
      { role: "user", parts: [{ text: "Inspect all screenshots" }] },
      {
        role: "model",
        parts: calls.map((call) => ({ functionCall: call })),
      },
      {
        role: "model",
        parts: calls.map((call, index) => ({
          functionResponse: {
            id: call.id,
            name: call.name,
            response: { output: `shot-${index}` },
            parts: [
              {
                inlineData: {
                  mimeType: "image/png",
                  data: index === 0 ? oversizedPng : makePng(index),
                },
              },
            ],
          },
        })),
      },
    ],
  })

  expect(response.status).toBe(200)
  const payload = sent[0] as {
    messages: Array<{ role: string; tool_call_id?: string; content: unknown }>
  }
  const toolMessages = payload.messages.filter((msg) => msg.role === "tool")
  expect(toolMessages).toHaveLength(15)
  for (const msg of toolMessages) {
    expect(typeof msg.content).toBe("string")
  }

  const followUpUser = payload.messages.at(-1)
  expect(followUpUser?.role).toBe("user")
  expect(Array.isArray(followUpUser?.content)).toBe(true)
  const parts = followUpUser?.content as Array<{
    type: string
    text?: string
    image_url?: { url: string }
  }>
  const omittedText = parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
  expect(omittedText.some((text) => text.includes("exceeds Copilot's"))).toBe(
    true,
  )
  expect(
    omittedText.filter((text) => text.includes("earlier image omitted")),
  ).toHaveLength(4)

  const forwardedUrls = parts
    .filter((part) => part.type === "image_url")
    .map((part) => part.image_url?.url)
  expect(forwardedUrls).toEqual(
    Array.from({ length: 10 }, (_, offset) => {
      const idx = offset + 5
      return `data:image/png;base64,${makePng(idx)}`
    }),
  )
})

test("models list accepts omitted supported_endpoints, falls back to context window, and refreshes token on 401", async () => {
  state.githubToken = "fake-github-token"
  state.copilotToken = "expired-token"
  let modelsAttempts = 0
  let tokenRefreshes = 0
  const omittedEndpoints: Model = {
    ...model,
    id: "gemini-omitted-endpoints",
    supported_endpoints: undefined,
    capabilities: {
      ...model.capabilities,
      limits: {
        max_context_window_tokens: 1_000_000,
        max_output_tokens: 65536,
      },
    },
  }
  globalThis.fetch = Object.assign(
    (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (url === "https://api.github.com/copilot_internal/v2/token") {
        tokenRefreshes++
        return Promise.resolve(
          Response.json({ token: "fresh-token", refresh_in: 1800 }),
        )
      }
      modelsAttempts++
      if (modelsAttempts === 1)
        return Promise.resolve(new Response("Unauthorized", { status: 401 }))
      return Promise.resolve(
        Response.json({ object: "list", data: [omittedEndpoints] }),
      )
    },
    { preconnect: originalFetch.preconnect },
  )

  const response = await server.request("/v1beta/models")
  expect(response.status).toBe(200)
  expect(tokenRefreshes).toBe(1)
  expect(modelsAttempts).toBe(2)
  expect(await response.json()).toMatchObject({
    models: [
      {
        name: "models/gemini-omitted-endpoints",
        inputTokenLimit: 1_000_000,
        outputTokenLimit: 65536,
      },
    ],
  })
})
