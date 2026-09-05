import { afterEach, describe, expect, test } from "bun:test"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/routes/messages/anthropic-types"
import type { ResponsesApiResponse } from "~/routes/responses/types"

import { state } from "~/lib/state"
import {
  translateAnthropicMessagesToResponses,
  translateResponsesToAnthropicMessage,
  writeResponsesAsAnthropicStream,
} from "~/routes/messages/responses-bridge"

afterEach(() => {
  state.models = undefined
})

function cacheModel(id: string, efforts?: ReadonlyArray<string>) {
  state.models = {
    object: "list",
    data: [
      {
        id,
        object: "model",
        name: id,
        model_picker_enabled: true,
        preview: false,
        vendor: "openai",
        version: "1",
        supported_endpoints: ["/responses"],
        capabilities: {
          family: id,
          limits: {},
          object: "model_capabilities",
          supports: { reasoning_effort: efforts ? [...efforts] : undefined },
          tokenizer: "o200k_base",
          type: "chat",
        },
      },
    ],
  }
}

const request: AnthropicMessagesPayload = {
  model: "client-model-alias",
  max_tokens: 100,
  messages: [{ role: "user", content: "Explain the result" }],
}

describe("Messages Responses reasoning effort", () => {
  test.each(["high", "xhigh", "max"] as const)(
    "forwards advertised %s effort using the resolved model's capabilities",
    (effort) => {
      cacheModel("gpt-5.5", ["high", "xhigh", "max"])

      const result = translateAnthropicMessagesToResponses(
        { ...request, output_config: { effort } },
        "gpt-5.5",
      )

      expect(result.model).toBe("gpt-5.5")
      expect(result.reasoning).toEqual({ effort })
    },
  )

  test.each([
    { label: "unsupported effort", efforts: ["high"] },
    { label: "empty effort support", efforts: [] },
    { label: "absent effort support", efforts: undefined },
  ])("omits reasoning for $label", ({ efforts }) => {
    cacheModel("gpt-5.5", efforts)

    const result = translateAnthropicMessagesToResponses(
      { ...request, output_config: { effort: "xhigh" } },
      "gpt-5.5",
    )

    const serialized = JSON.stringify(result)
    expect(JSON.parse(serialized)).not.toHaveProperty("reasoning")
  })

  test.each(["no cached models", "model absent from cache"])(
    "preserves requested effort with %s",
    (cacheState) => {
      if (cacheState === "model absent from cache") cacheModel("other-model")

      const result = translateAnthropicMessagesToResponses(
        { ...request, output_config: { effort: "xhigh" } },
        "gpt-5.5",
      )

      expect(result.reasoning).toEqual({ effort: "xhigh" })
    },
  )

  test("omits reasoning when no effort was requested", () => {
    cacheModel("gpt-5.5", ["high", "xhigh"])

    const result = translateAnthropicMessagesToResponses(request, "gpt-5.5")

    const serialized = JSON.stringify(result)
    expect(JSON.parse(serialized)).not.toHaveProperty("reasoning")
  })
})

interface ResponseCase {
  label: string
  response: ResponsesApiResponse
  stopReason: AnthropicResponse["stop_reason"]
  content: AnthropicResponse["content"]
  blockStart: Record<string, unknown>
  blockDelta: Record<string, unknown>
}

const textResponse: ResponsesApiResponse = {
  id: "resp_text",
  object: "response",
  created_at: 0,
  model: "upstream-model-id",
  output: [
    {
      id: "msg_text",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "The answer" }],
    },
  ],
  output_text: "The answer",
  status: "completed",
  usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
}

const toolResponse: ResponsesApiResponse = {
  ...textResponse,
  id: "resp_tool",
  output: [
    {
      id: "fc_read",
      type: "function_call",
      status: "completed",
      call_id: "call_read",
      name: "read_file",
      arguments: '{"path":"README.md"}',
    },
  ],
  output_text: "",
}

const responseCases: Array<ResponseCase> = [
  {
    label: "completed text ends the turn",
    response: textResponse,
    stopReason: "end_turn",
    content: [{ type: "text", text: "The answer" }],
    blockStart: { type: "text", text: "" },
    blockDelta: { type: "text_delta", text: "The answer" },
  },
  {
    label: "completed tool calls request tool use",
    response: toolResponse,
    stopReason: "tool_use",
    content: [
      {
        type: "tool_use",
        id: "call_read",
        name: "read_file",
        input: { path: "README.md" },
      },
    ],
    blockStart: {
      type: "tool_use",
      id: "call_read",
      name: "read_file",
      input: {},
    },
    blockDelta: {
      type: "input_json_delta",
      partial_json: '{"path":"README.md"}',
    },
  },
  {
    label: "truncated text reports max_tokens",
    response: {
      ...textResponse,
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ ...textResponse.output[0], status: "incomplete" }],
    },
    stopReason: "max_tokens",
    content: [{ type: "text", text: "The answer" }],
    blockStart: { type: "text", text: "" },
    blockDelta: { type: "text_delta", text: "The answer" },
  },
  {
    label: "truncated tool calls report max_tokens before tool_use",
    response: {
      ...toolResponse,
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [
        {
          ...toolResponse.output[0],
          status: "incomplete",
          arguments: '{"path":',
        },
      ],
    },
    stopReason: "max_tokens",
    content: [
      { type: "tool_use", id: "call_read", name: "read_file", input: {} },
    ],
    blockStart: {
      type: "tool_use",
      id: "call_read",
      name: "read_file",
      input: {},
    },
    blockDelta: { type: "input_json_delta", partial_json: "{}" },
  },
]

describe("Messages Responses stop reasons", () => {
  test.each(responseCases)(
    "nonstreaming: $label",
    ({ response, stopReason, content }) => {
      const result = translateResponsesToAnthropicMessage(
        response,
        "client-model-alias",
      )

      expect(result).toMatchObject({
        type: "message",
        role: "assistant",
        model: "client-model-alias",
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 7 },
      })
    },
  )

  test.each(responseCases)(
    "streaming: $label",
    async ({ response, stopReason, blockStart, blockDelta }) => {
      const events: Array<{ event: string; data: unknown }> = []
      await writeResponsesAsAnthropicStream(
        {
          writeSSE(event) {
            events.push({ event: event.event, data: JSON.parse(event.data) })
            return Promise.resolve()
          },
        },
        response,
        "client-model-alias",
      )

      expect(events[0]).toMatchObject({
        event: "message_start",
        data: {
          type: "message_start",
          message: {
            model: "client-model-alias",
            content: [],
            stop_reason: null,
            usage: { input_tokens: 12, output_tokens: 0 },
          },
        },
      })
      expect(
        events.find((event) => event.event === "content_block_start"),
      ).toMatchObject({ data: { index: 0, content_block: blockStart } })
      expect(
        events.find((event) => event.event === "content_block_delta"),
      ).toMatchObject({ data: { index: 0, delta: blockDelta } })
      expect(events.find((event) => event.event === "message_delta")).toEqual({
        event: "message_delta",
        data: {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: 7 },
        },
      })
      expect(events.at(-1)).toEqual({
        event: "message_stop",
        data: { type: "message_stop" },
      })
    },
  )
})
