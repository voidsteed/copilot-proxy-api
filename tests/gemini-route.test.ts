import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import consola from "consola"
import { z } from "zod"

import type { Model } from "~/services/copilot/get-models"

import { state } from "~/lib/state"
import { requestSchema } from "~/routes/gemini/schemas"
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
let sent: Array<unknown> = []
let responseBody: object = {
  id: "reply",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "hello" },
      finish_reason: "stop",
    },
  ],
}
beforeEach(() => {
  sent = []
  state.models = { object: "list", data: [model] }
  state.copilotToken = "fake-upstream"
  state.localApiKeys = []
  state.rateLimitSeconds = undefined
  globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      expect(input instanceof Request ? input.url : input.toString()).toMatch(
        /^https:\/\/api(?:\.[a-z]+)?\.githubcopilot\.com\/chat\/completions$/,
      )
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer fake-upstream",
      )
      if (init?.body && typeof init.body === "string")
        sent.push(JSON.parse(init.body))
      return Promise.resolve(Response.json(responseBody))
    },
    { preconnect: originalFetch.preconnect },
  )
})

const observedCall = {
  id: "mock-read-file-20261115-unique-01",
  name: "read_file",
  args: {
    Path: "/Volumes/mac-ssd/AI/projects/copilot-proxy-antigravity-20261115--4129943b1741/cli-verify/workspace/marker.txt",
  },
}
const observedSignature = "bW9jay1vcGFxdWUtdGhvdWdodC1zaWduYXR1cmUtMjAyNjExMTU="
const observedResult = {
  output:
    "Created At: 2026-11-15T20:33:54-08:00\nCompleted At: 2026-11-15T20:33:54-08:00\nShowing lines 1-1 of 1\n1: MARKER_ONLY_20261115",
}
const observedHistory = [
  { role: "user", parts: [{ text: "Read the marker." }] },
  {
    role: "model",
    parts: [
      { functionCall: observedCall, thoughtSignature: observedSignature },
    ],
  },
  {
    role: "model",
    parts: [
      {
        functionResponse: {
          id: observedCall.id,
          name: observedCall.name,
          response: observedResult,
        },
      },
    ],
  },
] satisfies z.infer<typeof requestSchema>["contents"]
const observedAssistantAndResult = [
  {
    role: "assistant",
    content: null,
    reasoning_opaque: observedSignature,
    tool_calls: [
      {
        id: observedCall.id,
        type: "function",
        function: {
          name: observedCall.name,
          arguments: JSON.stringify(observedCall.args),
        },
      },
    ],
  },
  {
    role: "tool",
    tool_call_id: observedCall.id,
    content: JSON.stringify(observedResult),
  },
]
test("actual CLI model-role functionResponse preserves the call, signature, and result", async () => {
  expect((await generate({ contents: observedHistory })).status).toBe(200)
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({
    messages: [
      { role: "user", content: "Read the marker." },
      ...observedAssistantAndResult,
    ],
  })
})

const capturedHistoryPath = process.env.GEMINI_CLI_HISTORY_FIXTURE
test.skipIf(!capturedHistoryPath)(
  "unchanged actual CLI second request crosses Hono and preserves all 14 schemas",
  async () => {
    if (!capturedHistoryPath) throw new Error("Missing CLI history fixture")
    const raw: unknown = await Bun.file(capturedHistoryPath).json()
    const body = requestSchema.parse(raw)
    expect(body.contents.map((content) => content.role)).toEqual([
      "user",
      "model",
      "model",
    ])
    expect(body.contents.slice(1)).toEqual(observedHistory.slice(1))
    state.models = {
      object: "list",
      data: [
        {
          ...model,
          capabilities: {
            ...model.capabilities,
            limits: { max_output_tokens: 64000 },
          },
        },
      ],
    }
    expect(body.generationConfig?.maxOutputTokens).toBe(65536)
    expect((await generate(raw)).status).toBe(200)
    expect(sent).toHaveLength(1)
    const declarations = body.tools?.flatMap(
      (tool) => tool.functionDeclarations,
    )
    expect(declarations).toHaveLength(14)
    expect(sent[0]).toMatchObject({
      max_tokens: 64000,
      reasoning_effort: "medium",
      messages: [
        {
          role: "system",
          content: body.systemInstruction?.parts
            .map((part) => part.text)
            .join("\n"),
        },
        {
          role: "user",
          content: body.contents[0].parts
            .map((part) => ("text" in part ? part.text : ""))
            .join(""),
        },
        ...observedAssistantAndResult,
      ],
      tools: declarations?.map((declaration) => ({
        type: "function",
        function: {
          name: declaration.name,
          description: declaration.description,
          parameters: declaration.parametersJsonSchema,
        },
      })),
    })
  },
)

test("model-role results retain pending-call and content-kind validation", async () => {
  for (const result of [
    { id: "unknown", name: observedCall.name },
    { id: observedCall.id, name: "wrong_name" },
  ]) {
    expect(
      (
        await generate({
          contents: [
            ...observedHistory.slice(0, 2),
            {
              role: "model",
              parts: [
                { functionResponse: { ...result, response: observedResult } },
              ],
            },
          ],
        })
      ).status,
    ).toBe(400)
  }
  for (const contents of [
    observedHistory.slice(2),
    [
      ...observedHistory.slice(0, 2),
      { role: "model", parts: [{ text: "unresolved model turn" }] },
    ],
    [
      ...observedHistory.slice(0, 2),
      {
        role: "model",
        parts: [...observedHistory[2].parts, { text: "mixed model result" }],
      },
    ],
    [{ role: "user", parts: [{ functionCall: observedCall }] }],
    [
      {
        role: "model",
        parts: [{ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }],
      },
    ],
  ]) {
    expect((await generate({ contents })).status).toBe(400)
  }
  expect(sent).toHaveLength(0)
})
afterEach(() => {
  globalThis.fetch = originalFetch
  state.models = undefined
  state.rateLimitSeconds = undefined
  state.localApiKeys = []
  state.manualApprove = false
})
function generate(body: unknown, action = "generateContent") {
  return server.request(`/v1beta/models/gemini-4-carbon:${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}
const textRequest = { contents: [{ role: "user", parts: [{ text: "hello" }] }] }
test("Google generation crosses the real HTTP and Copilot fetch boundary", async () => {
  const response = await generate({
    ...textRequest,
    systemInstruction: { role: "user", parts: [{ text: "system" }] },
    generationConfig: {
      maxOutputTokens: 65536,
      thinkingConfig: { includeThoughts: true, thinkingLevel: "MEDIUM" },
    },
    tools: [
      {
        functionDeclarations: [
          {
            name: "read_file",
            parametersJsonSchema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
              additionalProperties: false,
            },
          },
        ],
      },
    ],
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    candidates: [
      {
        content: { role: "model", parts: [{ text: "hello" }] },
        finishReason: "STOP",
      },
    ],
  })
  expect(sent[0]).toMatchObject({
    model: model.id,
    max_tokens: 65536,
    reasoning_effort: "medium",
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "hello" },
    ],
    tools: [
      {
        function: {
          name: "read_file",
          parameters: { additionalProperties: false, required: ["path"] },
        },
      },
    ],
  })
})
test("CLI output maximum is bounded by the advertised model limit without changing tool history", async () => {
  const maximum = 64000
  state.models = {
    object: "list",
    data: [
      {
        ...model,
        capabilities: {
          ...model.capabilities,
          limits: { max_output_tokens: maximum },
        },
      },
    ],
  }
  const declarations = Array.from({ length: 14 }, (_, index) => ({
    name: index === 0 ? observedCall.name : `tool_${index}`,
    parametersJsonSchema: {
      type: "object",
      properties: { Path: { type: "string" } },
      required: ["Path"],
      additionalProperties: false,
    },
  }))
  const response = await generate({
    contents: observedHistory,
    tools: [{ functionDeclarations: declarations }],
    generationConfig: {
      maxOutputTokens: 65536,
      thinkingConfig: { includeThoughts: true, thinkingLevel: "MEDIUM" },
    },
  })
  expect(response.status).toBe(200)
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({
    model: model.id,
    max_tokens: maximum,
    reasoning_effort: "medium",
    messages: [
      { role: "user", content: "Read the marker." },
      ...observedAssistantAndResult,
    ],
    tools: declarations.map((declaration) => ({
      type: "function",
      function: {
        name: declaration.name,
        parameters: declaration.parametersJsonSchema,
      },
    })),
  })
  const advertised = await server.request(`/v1beta/models/${model.id}`)
  expect(await advertised.json()).toMatchObject({ outputTokenLimit: maximum })
})
test("output maximum preserves smaller requests and defaults only to valid advertised limits", async () => {
  for (const [advertised, requested, expected] of [
    [32768, 1024, 1024],
    [32768, undefined, 32768],
    [undefined, 65536, 65536],
    [undefined, undefined, undefined],
    [0, 65536, 65536],
    [-1, 65536, 65536],
    [Number.POSITIVE_INFINITY, 65536, 65536],
    [Number.NaN, 65536, 65536],
    [0, undefined, undefined],
    [Number.NaN, undefined, undefined],
  ]) {
    state.models = {
      object: "list",
      data: [
        {
          ...model,
          capabilities: {
            ...model.capabilities,
            limits: { max_output_tokens: advertised },
          },
        },
      ],
    }
    sent = []
    const response = await generate({
      ...textRequest,
      generationConfig: { maxOutputTokens: requested },
    })
    expect(response.status).toBe(200)
    expect(sent).toHaveLength(1)
    if (expected === undefined) expect(sent[0]).not.toHaveProperty("max_tokens")
    else expect(sent[0]).toMatchObject({ max_tokens: expected })
  }
})
test("unsupported semantics fail before upstream", async () => {
  for (const extra of [
    { safetySettings: [] },
    { cachedContent: "cachedContents/a" },
    { generationConfig: { thinkingConfig: { thinkingBudget: 10 } } },
    { contents: [{ parts: [{ fileData: { fileUri: "gs://a" } }] }] },
  ]) {
    expect((await generate({ ...textRequest, ...extra })).status).toBe(400)
  }
  expect(sent).toHaveLength(0)
  expect((await generate(textRequest, "streamGenerateContent")).status).toBe(
    400,
  )
})
test("same-name calls preserve explicit IDs, structured results, order, and empty signature parts", async () => {
  const response = await generate({
    contents: [
      {
        role: "model",
        parts: [
          { text: "", thoughtSignature: "opaque==" },
          { functionCall: { id: "a", name: "read", args: { n: 1 } } },
          { functionCall: { id: "b", name: "read", args: { n: 2 } } },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              id: "b",
              name: "read",
              response: { result: [2] },
            },
          },
          {
            functionResponse: {
              id: "a",
              name: "read",
              response: { result: [1] },
            },
          },
        ],
      },
    ],
  })
  expect(response.status).toBe(200)
  expect(sent[0]).toMatchObject({
    messages: [
      {
        role: "assistant",
        reasoning_opaque: "opaque==",
        tool_calls: [{ id: "a" }, { id: "b" }],
      },
      { role: "tool", tool_call_id: "b", content: '{"result":[2]}' },
      { role: "tool", tool_call_id: "a", content: '{"result":[1]}' },
    ],
  })
})
test("opaque signatures round trip without manufacturing a signature", async () => {
  responseBody = {
    id: "reply",
    choices: [
      {
        index: 0,
        message: {
          content: null,
          reasoning_opaque: "signed+/==",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "read", arguments: '{"x":1}' },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  }
  const response = await generate(textRequest)
  const body: unknown = await response.json()
  expect(body).toMatchObject({
    candidates: [
      {
        content: {
          parts: [
            {
              functionCall: { id: "call-1", name: "read", args: { x: 1 } },
              thoughtSignature: "signed+/==",
            },
          ],
        },
      },
    ],
  })
  const emitted = z
    .object({
      candidates: z.array(
        z.object({
          content: z.object({
            role: z.literal("model"),
            parts: z.array(z.unknown()),
          }),
        }),
      ),
    })
    .parse(body)
  const continued = await generate({
    contents: [
      ...textRequest.contents,
      emitted.candidates[0].content,
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              id: "call-1",
              name: "read",
              response: { result: [1, 2] },
            },
          },
        ],
      },
    ],
  })
  expect(continued.status).toBe(200)
  expect(sent[1]).toMatchObject({
    messages: [
      { role: "user" },
      {
        role: "assistant",
        reasoning_opaque: "signed+/==",
        tool_calls: [{ id: "call-1", function: { arguments: '{"x":1}' } }],
      },
      { role: "tool", tool_call_id: "call-1", content: '{"result":[1,2]}' },
    ],
  })
  responseBody = {
    choices: [
      { index: 0, message: { content: "hello" }, finish_reason: "stop" },
    ],
  }
})

test("fresh Google list/get filters actual capabilities and keeps Carbon's exact ID", async () => {
  state.models = { object: "list", data: [] }
  const catalog = {
    object: "list",
    data: [
      model,
      { ...model, id: "nongoogle", vendor: "OpenAI" },
      {
        ...model,
        id: "embedding",
        capabilities: { ...model.capabilities, type: "embedding" },
      },
      { ...model, id: "responses-only", supported_endpoints: ["/responses"] },
    ],
  }
  globalThis.fetch = Object.assign(
    () => Promise.resolve(Response.json(catalog)),
    { preconnect: originalFetch.preconnect },
  )
  const list = await server.request("/v1beta/models")
  expect(await list.json()).toMatchObject({
    models: [
      {
        name: "models/gemini-4-carbon",
        supportedGenerationMethods: [
          "generateContent",
          "streamGenerateContent",
        ],
      },
    ],
  })
  const read = await server.request("/v1beta/models/gemini-4-carbon")
  expect(await read.json()).toMatchObject({ name: "models/gemini-4-carbon" })
  const unknown = await server.request(
    "/v1beta/models/gemini-4-carbon-alias:generateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(textRequest),
    },
  )
  expect(unknown.status).toBe(404)
  expect(sent).toHaveLength(0)
})
test("unrepresentable signatures, result mismatches, and response schemas are rejected", async () => {
  const invalid = [
    {
      contents: [
        {
          role: "model",
          parts: [
            { text: "", thoughtSignature: "one" },
            { text: "", thoughtSignature: "two" },
          ],
        },
      ],
    },
    {
      contents: [
        {
          parts: [
            { functionResponse: { name: "orphan", response: { ok: true } } },
          ],
        },
      ],
    },
    {
      ...textRequest,
      generationConfig: { responseSchema: { type: "OBJECT" } },
    },
  ]
  for (const body of invalid) expect((await generate(body)).status).toBe(400)
  expect(sent).toHaveLength(0)
})
test("ID-free same-name sequential calls correlate by order and preserve structured results", async () => {
  const response = await generate({
    contents: [
      {
        role: "model",
        parts: [
          { functionCall: { name: "read", args: { n: 1 } } },
          { functionCall: { name: "read", args: { n: 2 } } },
        ],
      },
      {
        role: "user",
        parts: [
          { functionResponse: { name: "read", response: { n: 1 } } },
          { functionResponse: { name: "read", response: { n: 2 } } },
        ],
      },
      {
        role: "model",
        parts: [{ functionCall: { name: "read", args: { n: 3 } } }],
      },
      {
        role: "user",
        parts: [{ functionResponse: { name: "read", response: { n: 3 } } }],
      },
    ],
  })
  expect(response.status).toBe(200)
  expect(sent[0]).toMatchObject({
    messages: [
      { tool_calls: [{ id: "gemini_call_0" }, { id: "gemini_call_1" }] },
      { tool_call_id: "gemini_call_0", content: '{"n":1}' },
      { tool_call_id: "gemini_call_1", content: '{"n":2}' },
      { tool_calls: [{ id: "gemini_call_2" }] },
      { tool_call_id: "gemini_call_2", content: '{"n":3}' },
    ],
  })
})
test("inline images and supported generation fields remain intact", async () => {
  const response = await generate({
    contents: [
      {
        parts: [
          { text: "look" },
          { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.3,
      topP: 0.8,
      stopSequences: ["END"],
      presencePenalty: 0.1,
      frequencyPenalty: -0.2,
      responseMimeType: "application/json",
      candidateCount: 1,
    },
    tools: [{ functionDeclarations: [{ name: "read" }] }],
    toolConfig: {
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["read"] },
    },
  })
  expect(response.status).toBe(200)
  expect(sent[0]).toMatchObject({
    temperature: 0.3,
    top_p: 0.8,
    stop: ["END"],
    presence_penalty: 0.1,
    frequency_penalty: -0.2,
    response_format: { type: "json_object" },
    tool_choice: { type: "function", function: { name: "read" } },
    messages: [
      {
        content: [
          { type: "text", text: "look" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,aGVsbG8=" },
          },
        ],
      },
    ],
  })
})
test("upstream HTTP status is preserved in a safe Google error envelope", async () => {
  globalThis.fetch = Object.assign(
    () =>
      Promise.resolve(
        Response.json(
          { error: { message: "secret prompt and credentials" } },
          { status: 422 },
        ),
      ),
    { preconnect: originalFetch.preconnect },
  )
  const response = await generate(textRequest)
  expect(response.status).toBe(422)
  expect(await response.json()).toEqual({
    error: { code: 422, status: "UNKNOWN", message: "Upstream request failed" },
  })
})
test("existing rate limit runs once and prevents a second inference", async () => {
  state.rateLimitSeconds = 600
  state.lastRequestTimestamp = undefined
  const first = await generate(textRequest)
  expect(first.status).toBe(200)
  const second = await generate(textRequest)
  expect(second.status).toBe(429)
  expect(sent).toHaveLength(1)
})

test("manual approval runs exactly once for a valid generation", async () => {
  const prompt = spyOn(consola, "prompt").mockResolvedValue(true)
  state.manualApprove = true
  try {
    expect((await generate(textRequest)).status).toBe(200)
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(1)
  } finally {
    prompt.mockRestore()
    state.manualApprove = false
  }
})
test("Google header auth protects inference and never forwards the local key", async () => {
  state.localApiKeys = ["local-google-test"]
  const denied = await generate(textRequest)
  expect(denied.status).toBe(401)
  expect(await denied.json()).toMatchObject({
    error: { code: 401, status: "UNAUTHENTICATED" },
  })
  let headers = new Headers()
  globalThis.fetch = Object.assign(
    (_input: string | URL | Request, init?: RequestInit) => {
      headers = new Headers(init?.headers)
      return Promise.resolve(Response.json(responseBody))
    },
    { preconnect: originalFetch.preconnect },
  )
  const allowed = await server.request(
    `/v1beta/models/${model.id}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": "local-google-test",
      },
      body: JSON.stringify(textRequest),
    },
  )
  expect(allowed.status).toBe(200)
  expect(headers.get("x-goog-api-key")).toBeNull()
  expect(headers.get("authorization")).toBe("Bearer fake-upstream")
})

test("ordered content that cannot survive the Copilot message shape is rejected", async () => {
  const invalid = [
    {
      contents: [
        {
          role: "model",
          parts: [{ functionCall: { name: "read" } }, { text: "after call" }],
        },
      ],
    },
    {
      contents: [
        {
          role: "model",
          parts: [
            { text: "answer" },
            { text: "late reasoning", thought: true },
          ],
        },
      ],
    },
    {
      contents: [
        { role: "model", parts: [{ functionCall: { name: "read" } }] },
        {
          role: "user",
          parts: [
            { text: "before result" },
            { functionResponse: { name: "read", response: { ok: true } } },
          ],
        },
      ],
    },
  ]
  for (const body of invalid) expect((await generate(body)).status).toBe(400)
  expect(sent).toHaveLength(0)
})
