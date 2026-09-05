import { afterEach, expect, mock, test } from "bun:test"

import type { ResponsesApiRequest } from "~/routes/responses/types"

import { state } from "~/lib/state"
import { createResponses } from "~/services/copilot/create-responses"

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
})

function bodyToString(body: unknown): string {
  if (typeof body !== "string") {
    throw new TypeError("expected fetch body to be a string")
  }
  return body
}

test("strips old Responses images when payload exceeds upstream byte limit", async () => {
  const imageUrl = `data:image/png;base64,${"a".repeat(1_000_000)}`
  const payload: ResponsesApiRequest = {
    model: "unknown-vision-model",
    input: Array.from({ length: 6 }, (_, index) => ({
      role: "user",
      content: [
        { type: "input_text", text: `Image ${index}` },
        { type: "input_image", image_url: imageUrl },
      ],
    })),
  }

  const fetchMock = mock((_url: string, opts: RequestInit) => {
    const body = bodyToString(opts.body)
    return new Response(JSON.stringify({ id: "resp_123" }), {
      status: body.length > 5_000_000 ? 413 : 200,
      headers: { "content-type": "application/json" },
    })
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await createResponses(payload)
  const sentBody = bodyToString(fetchMock.mock.calls[0][1].body)
  const forwarded = JSON.parse(sentBody) as ResponsesApiRequest

  expect(response.status).toBe(200)
  expect(sentBody.length).toBeLessThanOrEqual(5_000_000)
  expect(JSON.stringify(forwarded.input)).toContain(
    "image removed to stay under upstream payload limit",
  )
  expect(JSON.stringify(forwarded.input)).toContain("data:image/png;base64")
})

test("drops old Responses input history when payload exceeds model token budget", async () => {
  const payload: ResponsesApiRequest = {
    model: "gpt-5.5",
    instructions: "Keep the latest task context.",
    input: Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `Turn ${index}\n${"x".repeat(180_000)}`,
    })),
  }

  const fetchMock = mock((_url: string, opts: RequestInit) => {
    const body = bodyToString(opts.body)
    return new Response(JSON.stringify({ id: "resp_456" }), {
      status: body.length > 924_000 ? 400 : 200,
      headers: { "content-type": "application/json" },
    })
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await createResponses(payload)
  const sentBody = bodyToString(fetchMock.mock.calls[0][1].body)
  const forwarded = JSON.parse(sentBody) as ResponsesApiRequest

  expect(response.status).toBe(200)
  expect(sentBody.length).toBeLessThanOrEqual(924_000)
  expect(JSON.stringify(forwarded.input)).toContain(
    "older response input omitted to stay under context limit",
  )
  expect(JSON.stringify(forwarded.input)).toContain("Turn 7")
})

test("drops unknown large Responses item fields from old history", async () => {
  const payload = {
    model: "gpt-5.5",
    input: [
      {
        type: "function_call",
        call_id: "call_old",
        name: "read_image_batch",
        arguments: "x".repeat(5_200_000),
      },
      {
        role: "user",
        content: "continue",
      },
      {
        role: "assistant",
        content: "ready",
      },
    ],
  } as unknown as ResponsesApiRequest

  const fetchMock = mock((_url: string, opts: RequestInit) => {
    const body = bodyToString(opts.body)
    return new Response(JSON.stringify({ id: "resp_789" }), {
      status: body.length > 924_000 ? 413 : 200,
      headers: { "content-type": "application/json" },
    })
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await createResponses(payload)
  const sentBody = bodyToString(fetchMock.mock.calls[0][1].body)
  const forwarded = JSON.parse(sentBody) as ResponsesApiRequest

  expect(response.status).toBe(200)
  expect(sentBody.length).toBeLessThanOrEqual(924_000)
  expect(JSON.stringify(forwarded.input)).not.toContain("read_image_batch")
  expect(JSON.stringify(forwarded.input)).toContain("continue")
})

test("does not forward orphaned Responses function call outputs after fitting", async () => {
  const payload = {
    model: "gpt-5.5",
    input: [
      {
        type: "function_call",
        call_id: "call_old",
        name: "read_file",
        arguments: "{}",
      },
      ...Array.from({ length: 4 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `Old turn ${index}\n${"x".repeat(260_000)}`,
      })),
      {
        type: "function_call_output",
        call_id: "call_old",
        output: "file contents",
      },
      {
        role: "user",
        content: "continue",
      },
    ],
  } as unknown as ResponsesApiRequest

  const fetchMock = mock((_url: string, opts: RequestInit) => {
    const body = bodyToString(opts.body)
    const forwarded = JSON.parse(body) as ResponsesApiRequest
    const input = Array.isArray(forwarded.input) ? forwarded.input : []
    const callIds = new Set(
      input
        .filter((item) => item.type === "function_call")
        .map((item) => item.call_id),
    )
    const orphanedOutput = input.find(
      (item) =>
        item.type === "function_call_output"
        && item.call_id
        && !callIds.has(item.call_id),
    )

    return new Response(
      JSON.stringify(
        orphanedOutput ?
          {
            error: {
              message: `No tool call found for function call output with call_id ${orphanedOutput.call_id}.`,
              code: "invalid_request_body",
            },
          }
        : { id: "resp_paired" },
      ),
      {
        status: orphanedOutput ? 400 : 200,
        headers: { "content-type": "application/json" },
      },
    )
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await createResponses(payload)
  const sentBody = bodyToString(fetchMock.mock.calls[0][1].body)
  const forwarded = JSON.parse(sentBody) as ResponsesApiRequest

  expect(response.status).toBe(200)
  expect(sentBody.length).toBeLessThanOrEqual(924_000)
  expect(JSON.stringify(forwarded.input)).not.toContain(
    '"type":"function_call_output"',
  )
  expect(JSON.stringify(forwarded.input)).toContain(
    "older response input omitted to stay under context limit",
  )
})

test("does not forward orphaned Responses custom tool call outputs after fitting", async () => {
  const payload = {
    model: "gpt-5.5",
    input: [
      {
        type: "custom_tool_call",
        call_id: "call_custom_old",
        name: "browser_open",
        input: "https://example.com",
      },
      ...Array.from({ length: 4 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `Old custom turn ${index}\n${"x".repeat(260_000)}`,
      })),
      {
        type: "custom_tool_call_output",
        call_id: "call_custom_old",
        output: "opened",
      },
      {
        role: "user",
        content: "continue",
      },
    ],
  } as unknown as ResponsesApiRequest

  const fetchMock = mock((_url: string, opts: RequestInit) => {
    const body = bodyToString(opts.body)
    const forwarded = JSON.parse(body) as ResponsesApiRequest
    const input = Array.isArray(forwarded.input) ? forwarded.input : []
    const callIds = new Set(
      input
        .filter((item) => item.type === "custom_tool_call")
        .map((item) => item.call_id),
    )
    const orphanedOutput = input.find(
      (item) =>
        item.type === "custom_tool_call_output"
        && item.call_id
        && !callIds.has(item.call_id),
    )

    return new Response(
      JSON.stringify(
        orphanedOutput ?
          {
            error: {
              message: `No tool call found for custom tool call output with call_id ${orphanedOutput.call_id}.`,
              code: "invalid_request_body",
            },
          }
        : { id: "resp_custom_paired" },
      ),
      {
        status: orphanedOutput ? 400 : 200,
        headers: { "content-type": "application/json" },
      },
    )
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await createResponses(payload)
  const sentBody = bodyToString(fetchMock.mock.calls[0][1].body)
  const forwarded = JSON.parse(sentBody) as ResponsesApiRequest

  expect(response.status).toBe(200)
  expect(sentBody.length).toBeLessThanOrEqual(924_000)
  expect(JSON.stringify(forwarded.input)).not.toContain(
    '"type":"custom_tool_call_output"',
  )
  expect(JSON.stringify(forwarded.input)).toContain(
    "older response input omitted to stay under context limit",
  )
})

test("replaces invalid image URLs in Responses tool outputs", async () => {
  const payload: ResponsesApiRequest = {
    model: "gpt-5.5",
    input: [
      {
        type: "function_call",
        call_id: "call_image",
        name: "capture_screenshot",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "call_image",
        output: [
          {
            type: "output_text",
            image_url: "not a valid url",
          },
        ],
      },
      {
        role: "user",
        content: "continue",
      },
    ],
  }

  const fetchMock = mock((_url: string, opts: RequestInit) => {
    const body = bodyToString(opts.body)
    const forwarded = JSON.parse(body) as ResponsesApiRequest
    const input = Array.isArray(forwarded.input) ? forwarded.input : []
    const outputItem = input.find(
      (item) => item.type === "function_call_output",
    )
    const output = Array.isArray(outputItem?.output) ? outputItem.output : []
    const hasRejectedOutputText = output.some(
      (part) => part.type === "output_text",
    )
    const hasInvalidImageUrl = output.some(
      (part) => part.image_url === "not a valid url",
    )
    let responseBody: Record<string, unknown> = { id: "resp_image_output" }

    if (hasRejectedOutputText) {
      responseBody = {
        error: {
          message:
            "Invalid value: 'output_text'. Supported values are: 'input_text', 'input_image', 'input_file', 'scoped_content', and 'encrypted_content'.",
          code: "invalid_request_body",
        },
      }
    } else if (hasInvalidImageUrl) {
      responseBody = {
        error: {
          message:
            "Invalid 'input[1].output[0].image_url'. Expected a valid URL, but got a value with an invalid format.",
          code: "invalid_request_body",
        },
      }
    }

    return new Response(JSON.stringify(responseBody), {
      status: hasRejectedOutputText || hasInvalidImageUrl ? 400 : 200,
      headers: { "content-type": "application/json" },
    })
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await createResponses(payload)
  const sentBody = bodyToString(fetchMock.mock.calls[0][1].body)
  const forwarded = JSON.parse(sentBody) as ResponsesApiRequest

  expect(response.status).toBe(200)
  expect(JSON.stringify(forwarded.input)).not.toContain("not a valid url")
  expect(JSON.stringify(forwarded.input)).toContain(
    "image output removed because its URL is not valid",
  )
})

test("replaces local image URLs in Responses tool outputs", async () => {
  const localImageUrl = "file:///Users/test/.tmoxie-uploads/img.png"
  const remoteImageUrl = "https://example.com/render.png"
  const payload: ResponsesApiRequest = {
    model: "gpt-5.5",
    input: [
      {
        type: "function_call",
        call_id: "call_local_image",
        name: "capture_screenshot",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "call_local_image",
        output: [
          {
            type: "output_text",
            image_url: localImageUrl,
          },
          {
            type: "output_text",
            image_url: remoteImageUrl,
          },
        ],
      },
      {
        role: "user",
        content: "continue",
      },
    ],
  }

  const fetchMock = mock((_url: string, opts: RequestInit) => {
    const body = bodyToString(opts.body)
    const forwarded = JSON.parse(body) as ResponsesApiRequest
    const input = Array.isArray(forwarded.input) ? forwarded.input : []
    const outputItem = input.find(
      (item) => item.type === "function_call_output",
    )
    const output = Array.isArray(outputItem?.output) ? outputItem.output : []
    const hasRejectedOutputText = output.some(
      (part) => part.type === "output_text",
    )
    const hasLocalImageUrl = output.some(
      (part) => part.image_url === localImageUrl,
    )
    let responseBody: Record<string, unknown> = {
      id: "resp_local_image_output",
    }

    if (hasRejectedOutputText) {
      responseBody = {
        error: {
          message:
            "Invalid value: 'output_text'. Supported values are: 'input_text', 'input_image', 'input_file', 'scoped_content', and 'encrypted_content'.",
          code: "invalid_request_body",
        },
      }
    } else if (hasLocalImageUrl) {
      responseBody = {
        error: {
          message:
            "Invalid 'input[1].output[0].image_url'. Expected a valid URL, but got a value with an invalid format.",
          code: "invalid_request_body",
        },
      }
    }

    return new Response(JSON.stringify(responseBody), {
      status: hasRejectedOutputText || hasLocalImageUrl ? 400 : 200,
      headers: { "content-type": "application/json" },
    })
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await createResponses(payload)
  const sentBody = bodyToString(fetchMock.mock.calls[0][1].body)
  const forwarded = JSON.parse(sentBody) as ResponsesApiRequest

  expect(response.status).toBe(200)
  expect(JSON.stringify(forwarded.input)).not.toContain("file:///")
  expect(JSON.stringify(forwarded.input)).not.toContain('"type":"output_text"')
  expect(JSON.stringify(forwarded.input)).toContain(remoteImageUrl)
  expect(JSON.stringify(forwarded.input)).toContain(
    "image output removed because its URL is not valid",
  )
})

test("omits empty Responses tool descriptions", async () => {
  const payload: ResponsesApiRequest = {
    model: "gpt-5.5",
    input: "Use a tool",
    tools: [
      {
        type: "function",
        name: "flat_tool",
        description: "",
        parameters: { type: "object" },
      },
      {
        type: "function",
        function: {
          name: "nested_tool",
          description: "",
          parameters: { type: "object" },
        },
      },
      {
        type: "function",
        name: "documented_tool",
        description: "Keep this description",
        parameters: { type: "object" },
      },
    ],
  }

  const fetchMock = mock((_url: string, opts: RequestInit) => {
    const forwarded = JSON.parse(bodyToString(opts.body)) as ResponsesApiRequest
    const hasEmptyDescription = forwarded.tools?.some(
      (tool) => tool.description === "" || tool.function?.description === "",
    )

    return new Response(
      JSON.stringify(
        hasEmptyDescription ?
          {
            error: {
              message:
                "Invalid tool description: empty string. Expected a string with minimum length 1.",
              code: "invalid_request_body",
            },
          }
        : { id: "resp_tools" },
      ),
      {
        status: hasEmptyDescription ? 400 : 200,
        headers: { "content-type": "application/json" },
      },
    )
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await createResponses(payload)
  const sentBody = bodyToString(fetchMock.mock.calls[0][1].body)
  const forwarded = JSON.parse(sentBody) as ResponsesApiRequest

  expect(response.status).toBe(200)
  expect(forwarded.tools?.[0]).not.toHaveProperty("description")
  expect(forwarded.tools?.[1].function).not.toHaveProperty("description")
  expect(forwarded.tools?.[2].description).toBe("Keep this description")
})

test("fills required tool descriptions in Responses input history", async () => {
  const payload: ResponsesApiRequest = {
    model: "gpt-5.5",
    input: [
      {
        type: "message",
        role: "developer",
        content: "Use a replayed tool",
        tools: [
          {
            type: "function",
            name: "flat_history_tool",
            description: "",
            parameters: { type: "object" },
          },
          {
            type: "function",
            function: {
              name: "nested_history_tool",
              description: "",
              parameters: { type: "object" },
            },
          },
          {
            type: "function",
            name: "documented_history_tool",
            description: "Keep this history description",
            parameters: { type: "object" },
          },
          {
            type: "function",
            name: "missing_history_description",
            parameters: { type: "object" },
          },
          {
            type: "function",
            name: "blank_history_description",
            description: "   ",
            parameters: { type: "object" },
          },
        ],
      },
    ],
  }

  const fetchMock = mock((_url: string, opts: RequestInit) => {
    const forwarded = JSON.parse(bodyToString(opts.body)) as ResponsesApiRequest
    const input = Array.isArray(forwarded.input) ? forwarded.input : []
    const tools = input[0]?.tools as
      | Array<{
          description?: string
          function?: { description?: string }
        }>
      | undefined
    const invalidTool = tools?.find(
      (tool) =>
        typeof tool.description !== "string" || tool.description.length === 0,
    )
    let errorMessage: string | undefined
    if (invalidTool?.description === "") {
      errorMessage =
        "Invalid 'input[0].tools[0].description': empty string. Expected a string with minimum length 1, but got an empty string instead."
    } else if (invalidTool) {
      errorMessage =
        "Missing required parameter: 'input[0].tools[0].description'."
    }

    return new Response(
      JSON.stringify(
        errorMessage ?
          {
            error: {
              message: errorMessage,
              code: "invalid_request_body",
            },
          }
        : { id: "resp_history_tools" },
      ),
      {
        status: errorMessage ? 400 : 200,
        headers: { "content-type": "application/json" },
      },
    )
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await createResponses(payload)
  const forwarded = JSON.parse(
    bodyToString(fetchMock.mock.calls[0][1].body),
  ) as ResponsesApiRequest
  const input = Array.isArray(forwarded.input) ? forwarded.input : []
  const tools = input[0]?.tools as Array<{
    description?: string
    function?: { description?: string }
  }>

  expect(response.status).toBe(200)
  expect(tools[0].description).toBe("Tool flat_history_tool")
  expect(tools[1].description).toBe("Tool nested_history_tool")
  expect(tools[1].function).not.toHaveProperty("description")
  expect(tools[2].description).toBe("Keep this history description")
  expect(tools[3].description).toBe("Tool missing_history_description")
  expect(tools[4].description).toBe("Tool blank_history_description")
})

test("removes unsupported GPT-6 Astra sampling and logprob parameters", async () => {
  const payload = {
    model: "gpt-6-astra",
    input: "Say hello",
    temperature: 0.2,
    top_p: 0.9,
    top_logprobs: 5,
    logprobs: true,
    include: ["message.output_text.logprobs", "reasoning.encrypted_content"],
  } as ResponsesApiRequest

  const fetchMock = mock((_url: string, opts: RequestInit) => {
    const forwarded = JSON.parse(bodyToString(opts.body)) as Record<
      string,
      unknown
    >
    const include = forwarded.include as Array<string> | undefined
    const hasUnsupportedParameter =
      "temperature" in forwarded
      || "top_p" in forwarded
      || "top_logprobs" in forwarded
      || "logprobs" in forwarded
      || include?.includes("message.output_text.logprobs")

    return new Response(
      JSON.stringify(
        hasUnsupportedParameter ?
          {
            error: {
              message: "Unsupported parameter for gpt-6-astra",
              code: "unsupported_parameter",
            },
          }
        : { id: "resp_astra" },
      ),
      {
        status: hasUnsupportedParameter ? 400 : 200,
        headers: { "content-type": "application/json" },
      },
    )
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await createResponses(payload)
  const forwarded = JSON.parse(
    bodyToString(fetchMock.mock.calls[0][1].body),
  ) as Record<string, unknown>

  expect(response.status).toBe(200)
  expect(forwarded).not.toHaveProperty("temperature")
  expect(forwarded).not.toHaveProperty("top_p")
  expect(forwarded).not.toHaveProperty("top_logprobs")
  expect(forwarded).not.toHaveProperty("logprobs")
  expect(forwarded.include).toEqual(["reasoning.encrypted_content"])
})

test.each(["gpt-5.6-sol", "gpt-6-astra-2026-09-01"])(
  "preserves sampling and logprob parameters for %s",
  async (model) => {
    const payload = {
      model,
      input: "Say hello",
      temperature: 0.2,
      top_p: 0.9,
      top_logprobs: 5,
      logprobs: true,
      include: ["message.output_text.logprobs", "reasoning.encrypted_content"],
    } as ResponsesApiRequest

    const fetchMock = mock((_url: string, opts: RequestInit) => {
      return new Response(bodyToString(opts.body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await createResponses(payload)
    const forwarded = JSON.parse(
      bodyToString(fetchMock.mock.calls[0][1].body),
    ) as Record<string, unknown>

    expect(forwarded.temperature).toBe(0.2)
    expect(forwarded.top_p).toBe(0.9)
    expect(forwarded.top_logprobs).toBe(5)
    expect(forwarded.logprobs).toBe(true)
    expect(forwarded.include).toEqual([
      "message.output_text.logprobs",
      "reasoning.encrypted_content",
    ])
  },
)

test("maps remaining upstream Responses 413 to prompt-too-long error", async () => {
  const payload: ResponsesApiRequest = {
    model: "gpt-5.5",
    input: "x".repeat(5_100_000),
    max_output_tokens: 1000,
  }

  const fetchMock = mock(
    () =>
      new Response(
        JSON.stringify({ error: { message: "failed to parse request" } }),
        { status: 413, headers: { "content-type": "application/json" } },
      ),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch

  let caught: unknown
  try {
    await createResponses(payload)
  } catch (error) {
    caught = error
  }

  expect(caught).toBeInstanceOf(Error)
  expect((caught as Error).message).toBe("Prompt too long")
})
