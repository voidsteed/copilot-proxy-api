import { describe, expect, test } from "bun:test"
import { z } from "zod"

import type { ResponsesApiRequest } from "~/routes/responses/types"

import {
  translateChatToResponses,
  translateResponsesToChat,
} from "../src/routes/responses/translation"

// Zod schema for a single message in the chat completion request.
const messageSchema = z.object({
  role: z.enum([
    "system",
    "user",
    "assistant",
    "tool",
    "function",
    "developer",
  ]),
  content: z.union([z.string(), z.object({}), z.array(z.any())]),
  name: z.string().optional(),
  tool_calls: z.array(z.any()).optional(),
  tool_call_id: z.string().optional(),
})

// Zod schema for the chat completion request payload.
const chatCompletionRequestSchema = z.object({
  messages: z.array(messageSchema).min(1, "Messages array cannot be empty."),
  model: z.string(),
  max_tokens: z.number().int().optional().nullable(),
  temperature: z.number().min(0).max(2).optional().nullable(),
  top_p: z.number().min(0).max(1).optional().nullable(),
  stream: z.boolean().optional().nullable(),
  tools: z.array(z.any()).optional(),
  tool_choice: z.union([z.string(), z.object({})]).optional(),
})

function isValidChatCompletionRequest(payload: unknown): boolean {
  const result = chatCompletionRequestSchema.safeParse(payload)
  return result.success
}

describe("Responses API to Chat Completions translation", () => {
  test("should translate minimal Responses payload with string input", () => {
    const responsesPayload: ResponsesApiRequest = {
      model: "gpt-5.2",
      input: "Hello, world!",
    }

    const chatPayload = translateResponsesToChat(responsesPayload)
    expect(isValidChatCompletionRequest(chatPayload)).toBe(true)
    expect(chatPayload.model).toBe("gpt-5.2")
    expect(chatPayload.messages).toHaveLength(1)
    expect(chatPayload.messages[0].role).toBe("user")
    expect(chatPayload.messages[0].content).toBe("Hello, world!")
  })

  test("should translate Responses payload with instructions as system message", () => {
    const responsesPayload: ResponsesApiRequest = {
      model: "gpt-5.2",
      input: "What is 2+2?",
      instructions: "You are a helpful math tutor.",
    }

    const chatPayload = translateResponsesToChat(responsesPayload)
    expect(isValidChatCompletionRequest(chatPayload)).toBe(true)
    expect(chatPayload.messages).toHaveLength(2)
    expect(chatPayload.messages[0].role).toBe("system")
    expect(chatPayload.messages[0].content).toBe(
      "You are a helpful math tutor.",
    )
    expect(chatPayload.messages[1].role).toBe("user")
    expect(chatPayload.messages[1].content).toBe("What is 2+2?")
  })

  test("should translate Responses payload with array input", () => {
    const responsesPayload: ResponsesApiRequest = {
      model: "gpt-5.2",
      input: [
        { role: "user", content: "Hello!" },
        { role: "assistant", content: "Hi there!" },
        { role: "user", content: "How are you?" },
      ],
    }

    const chatPayload = translateResponsesToChat(responsesPayload)
    expect(isValidChatCompletionRequest(chatPayload)).toBe(true)
    expect(chatPayload.messages).toHaveLength(3)
    expect(chatPayload.messages[0].content).toBe("Hello!")
    expect(chatPayload.messages[1].content).toBe("Hi there!")
    expect(chatPayload.messages[2].content).toBe("How are you?")
  })

  test("should translate Responses payload with content parts", () => {
    const responsesPayload: ResponsesApiRequest = {
      model: "gpt-5.2",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "First part." },
            { type: "input_text", text: "Second part." },
          ],
        },
      ],
    }

    const chatPayload = translateResponsesToChat(responsesPayload)
    expect(isValidChatCompletionRequest(chatPayload)).toBe(true)
    expect(chatPayload.messages).toHaveLength(1)
    expect(chatPayload.messages[0].content).toBe("First part.\nSecond part.")
  })

  test("should translate developer role to system", () => {
    const responsesPayload: ResponsesApiRequest = {
      model: "gpt-5.2",
      input: [{ role: "developer", content: "Be concise." }],
    }

    const chatPayload = translateResponsesToChat(responsesPayload)
    expect(isValidChatCompletionRequest(chatPayload)).toBe(true)
    expect(chatPayload.messages[0].role).toBe("system")
    expect(chatPayload.messages[0].content).toBe("Be concise.")
  })

  test("should translate tool_result to tool message", () => {
    const responsesPayload: ResponsesApiRequest = {
      model: "gpt-5.2",
      input: [
        {
          role: "user",
          content: "Get weather",
          type: "tool_result",
          tool_call_id: "call_123",
          output: "Weather is sunny",
        },
      ],
    }

    const chatPayload = translateResponsesToChat(responsesPayload)
    expect(isValidChatCompletionRequest(chatPayload)).toBe(true)
    expect(chatPayload.messages[0].role).toBe("tool")
    expect(chatPayload.messages[0].tool_call_id).toBe("call_123")
    expect(chatPayload.messages[0].content).toBe("Weather is sunny")
  })

  test("should translate tools to OpenAI format", () => {
    const responsesPayload: ResponsesApiRequest = {
      model: "gpt-5.2",
      input: "What's the weather?",
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get current weather",
            parameters: {
              type: "object",
              properties: { location: { type: "string" } },
            },
          },
        },
      ],
    }

    const chatPayload = translateResponsesToChat(responsesPayload)
    expect(isValidChatCompletionRequest(chatPayload)).toBe(true)
    expect(chatPayload.tools).toHaveLength(1)
    expect(chatPayload.tools?.[0].function.name).toBe("get_weather")
    expect(chatPayload.tools?.[0].function.description).toBe(
      "Get current weather",
    )
  })

  test("should translate tool_choice string values", () => {
    const responsesPayload: ResponsesApiRequest = {
      model: "gpt-5.2",
      input: "Hello",
      tool_choice: "auto",
    }

    const chatPayload = translateResponsesToChat(responsesPayload)
    expect(chatPayload.tool_choice).toBe("auto")
  })

  test("should translate tool_choice function object", () => {
    const responsesPayload: ResponsesApiRequest = {
      model: "gpt-5.2",
      input: "Hello",
      tool_choice: { type: "function", function: { name: "get_weather" } },
    }

    const chatPayload = translateResponsesToChat(responsesPayload)
    expect(chatPayload.tool_choice).toEqual({
      type: "function",
      function: { name: "get_weather" },
    })
  })

  test("should pass through optional parameters", () => {
    const responsesPayload: ResponsesApiRequest = {
      model: "gpt-5.2",
      input: "Hello",
      max_output_tokens: 1000,
      temperature: 0.7,
      top_p: 0.9,
      stream: true,
    }

    const chatPayload = translateResponsesToChat(responsesPayload)
    expect(chatPayload.max_tokens).toBe(1000)
    expect(chatPayload.temperature).toBe(0.7)
    expect(chatPayload.top_p).toBe(0.9)
    expect(chatPayload.stream).toBe(true)
  })
})

describe("Chat Completions to Responses API translation", () => {
  test("should translate simple text response", () => {
    const chatResponse = {
      id: "chatcmpl-123",
      object: "chat.completion" as const,
      created: 1700000000,
      model: "gpt-5.2",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant" as const,
            content: "Hello! How can I help you?",
          },
          logprobs: null,
          finish_reason: "stop" as const,
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 8,
        total_tokens: 18,
      },
    }

    const responsesResponse = translateChatToResponses(chatResponse, "gpt-5.2")
    expect(responsesResponse.id).toBe("chatcmpl-123")
    expect(responsesResponse.object).toBe("response")
    expect(responsesResponse.model).toBe("gpt-5.2")
    expect(responsesResponse.status).toBe("completed")
    expect(responsesResponse.output_text).toBe("Hello! How can I help you?")
    expect(responsesResponse.output).toHaveLength(1)
    expect(responsesResponse.output[0].type).toBe("message")
    expect(responsesResponse.usage?.input_tokens).toBe(10)
    expect(responsesResponse.usage?.output_tokens).toBe(8)
    expect(responsesResponse.usage?.total_tokens).toBe(18)
  })

  test("should translate tool call response", () => {
    const chatResponse = {
      id: "chatcmpl-456",
      object: "chat.completion" as const,
      created: 1700000000,
      model: "gpt-5.2",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant" as const,
            content: null,
            tool_calls: [
              {
                id: "call_abc123",
                type: "function" as const,
                function: {
                  name: "get_weather",
                  arguments: '{"location":"New York"}',
                },
              },
            ],
          },
          logprobs: null,
          finish_reason: "tool_calls" as const,
        },
      ],
    }

    const responsesResponse = translateChatToResponses(chatResponse, "gpt-5.2")
    expect(responsesResponse.output).toHaveLength(1)
    expect(responsesResponse.output[0].type).toBe("function_call")
    expect(responsesResponse.output[0].name).toBe("get_weather")
    expect(responsesResponse.output[0].arguments).toBe(
      '{"location":"New York"}',
    )
    expect(responsesResponse.output[0].call_id).toBe("call_abc123")
  })

  test("should translate response with both text and tool calls", () => {
    const chatResponse = {
      id: "chatcmpl-789",
      object: "chat.completion" as const,
      created: 1700000000,
      model: "gpt-5.2",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant" as const,
            content: "Let me check the weather for you.",
            tool_calls: [
              {
                id: "call_xyz",
                type: "function" as const,
                function: {
                  name: "get_weather",
                  arguments: '{"location":"Boston"}',
                },
              },
            ],
          },
          logprobs: null,
          finish_reason: "tool_calls" as const,
        },
      ],
    }

    const responsesResponse = translateChatToResponses(chatResponse, "gpt-5.2")
    expect(responsesResponse.output).toHaveLength(2)
    expect(responsesResponse.output[0].type).toBe("message")
    expect(responsesResponse.output[1].type).toBe("function_call")
    expect(responsesResponse.output_text).toBe(
      "Let me check the weather for you.",
    )
  })

  test("should use fallback model when response model is missing", () => {
    const chatResponse = {
      id: "chatcmpl-000",
      object: "chat.completion" as const,
      created: 1700000000,
      model: "",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant" as const,
            content: "Hello",
          },
          logprobs: null,
          finish_reason: "stop" as const,
        },
      ],
    }

    const responsesResponse = translateChatToResponses(
      chatResponse,
      "fallback-model",
    )
    expect(responsesResponse.model).toBe("fallback-model")
  })

  test("should handle response without usage", () => {
    const chatResponse = {
      id: "chatcmpl-no-usage",
      object: "chat.completion" as const,
      created: 1700000000,
      model: "gpt-5.2",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant" as const,
            content: "No usage info",
          },
          logprobs: null,
          finish_reason: "stop" as const,
        },
      ],
    }

    const responsesResponse = translateChatToResponses(chatResponse, "gpt-5.2")
    expect(responsesResponse.usage).toBeUndefined()
  })
})
