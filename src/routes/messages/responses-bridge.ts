import type {
  ResponsesApiRequest,
  ResponsesApiResponse,
  ResponsesContentPart,
  ResponsesInputItem,
  ResponsesOutputItem,
} from "~/routes/responses/types"

import type {
  AnthropicAssistantContentBlock,
  AnthropicImageBlock,
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
  AnthropicUserContentBlock,
} from "./anthropic-types"

interface SSEStream {
  writeSSE(event: { data: string; event: string }): Promise<void>
}

const MIN_RESPONSES_OUTPUT_TOKENS = 16

export function translateAnthropicMessagesToResponses(
  payload: AnthropicMessagesPayload,
  model: string,
): ResponsesApiRequest {
  return {
    model,
    input: payload.messages.flatMap((message) => translateMessage(message)),
    instructions: translateSystem(payload.system),
    max_output_tokens: Math.max(
      payload.max_tokens,
      MIN_RESPONSES_OUTPUT_TOKENS,
    ),
    temperature: payload.temperature,
    top_p: payload.top_p,
    stream: false,
    tools: payload.tools?.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
      // Anthropic tools allow optional and action-dependent fields. Copilot
      // Responses defaults omitted strictness to true and rewrites every
      // property as required, which makes multiplexed MCP schemas unusable.
      strict: false,
    })),
    tool_choice: translateToolChoice(payload.tool_choice),
  }
}

export function translateResponsesToAnthropicMessage(
  response: ResponsesApiResponse,
  clientModel: string,
): AnthropicResponse {
  const content = response.output.flatMap((item) => translateOutputItem(item))
  const hasToolUse = content.some((block) => block.type === "tool_use")
  const cachedTokens = response.usage?.input_tokens_details?.cached_tokens ?? 0

  return {
    id: response.id,
    type: "message",
    role: "assistant",
    content,
    model: clientModel,
    stop_reason: hasToolUse ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: Math.max(
        0,
        (response.usage?.input_tokens ?? 0) - cachedTokens,
      ),
      output_tokens: response.usage?.output_tokens ?? 0,
      ...(cachedTokens > 0 ? { cache_read_input_tokens: cachedTokens } : {}),
    },
  }
}

export async function writeResponsesAsAnthropicStream(
  stream: SSEStream,
  response: ResponsesApiResponse,
  clientModel: string,
) {
  const message = translateResponsesToAnthropicMessage(response, clientModel)

  await stream.writeSSE({
    event: "message_start",
    data: JSON.stringify({
      type: "message_start",
      message: {
        ...message,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...message.usage, output_tokens: 0 },
      },
    }),
  })

  for (const [index, block] of message.content.entries()) {
    if (block.type === "text") {
      await writeTextBlock(stream, index, block.text)
    } else if (block.type === "tool_use") {
      await writeToolUseBlock(stream, index, block)
    }
  }

  await stream.writeSSE({
    event: "message_delta",
    data: JSON.stringify({
      type: "message_delta",
      delta: {
        stop_reason: message.stop_reason,
        stop_sequence: null,
      },
      usage: { output_tokens: message.usage.output_tokens },
    }),
  })
  await stream.writeSSE({
    event: "message_stop",
    data: JSON.stringify({ type: "message_stop" }),
  })
}

function translateSystem(
  system: AnthropicMessagesPayload["system"],
): string | undefined {
  if (!system) return undefined
  if (typeof system === "string") return system
  return system.map((block) => block.text).join("\n\n")
}

function translateMessage(
  message: AnthropicMessagesPayload["messages"][number],
): Array<ResponsesInputItem> {
  if (message.role === "user") return translateUserMessage(message.content)
  return translateAssistantMessage(message.content)
}

function translateUserMessage(
  content: string | Array<AnthropicUserContentBlock>,
): Array<ResponsesInputItem> {
  if (typeof content === "string") return [{ role: "user", content }]

  const items: Array<ResponsesInputItem> = []
  const messageParts: Array<
    Exclude<AnthropicUserContentBlock, AnthropicToolResultBlock>
  > = []

  for (const block of content) {
    if (block.type === "tool_result") {
      items.push({
        type: "function_call_output",
        call_id: block.tool_use_id,
        output: stringifyToolResult(block.content),
      })
    } else {
      messageParts.push(block)
    }
  }

  const messageContent = translateInputContent(messageParts)
  if (messageContent) items.push({ role: "user", content: messageContent })
  return items
}

function translateAssistantMessage(
  content: string | Array<AnthropicAssistantContentBlock>,
): Array<ResponsesInputItem> {
  if (typeof content === "string") return [{ role: "assistant", content }]

  const items: Array<ResponsesInputItem> = []
  const text = content
    .filter((block): block is AnthropicTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n\n")
  if (text) items.push({ role: "assistant", content: text })

  for (const block of content) {
    if (block.type !== "tool_use") continue
    items.push({
      type: "function_call",
      call_id: block.id,
      name: block.name,
      arguments: JSON.stringify(block.input),
    })
  }

  return items
}

function translateInputContent(
  content: Array<Exclude<AnthropicUserContentBlock, AnthropicToolResultBlock>>,
): string | Array<ResponsesContentPart> | null {
  const hasImage = content.some((block) => block.type === "image")
  if (!hasImage) {
    const text = content
      .filter((block): block is AnthropicTextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n\n")
    return text || null
  }

  const parts: Array<ResponsesContentPart> = []
  for (const block of content) {
    if (block.type === "text") {
      parts.push({ type: "input_text", text: block.text })
    } else if (block.type === "image") {
      parts.push(translateImageBlock(block))
    }
  }
  return parts.length > 0 ? parts : null
}

function translateImageBlock(block: AnthropicImageBlock): ResponsesContentPart {
  return {
    type: "input_image",
    image_url: `data:${block.source.media_type};base64,${block.source.data}`,
  }
}

function translateToolChoice(
  toolChoice: AnthropicMessagesPayload["tool_choice"],
): ResponsesApiRequest["tool_choice"] {
  if (!toolChoice) return undefined
  if (toolChoice.type === "auto" || toolChoice.type === "none") {
    return toolChoice.type
  }
  if (toolChoice.type === "any") return "required"
  if (toolChoice.name) {
    return { type: "function", name: toolChoice.name }
  }
  return undefined
}

function stringifyToolResult(
  content: AnthropicToolResultBlock["content"],
): string {
  return typeof content === "string" ? content : JSON.stringify(content)
}

function translateOutputItem(
  item: ResponsesOutputItem,
): Array<AnthropicAssistantContentBlock> {
  if (item.type === "function_call" && item.name && item.call_id) {
    return [
      {
        type: "tool_use",
        id: item.call_id,
        name: item.name,
        input: parseToolInput(item.arguments),
      },
    ]
  }

  if (item.type !== "message" || !item.content) return []
  return item.content.flatMap((part) => {
    if (part.type !== "output_text" || !part.text) return []
    return [{ type: "text", text: part.text }]
  })
}

function parseToolInput(
  argumentsText: string | undefined,
): Record<string, unknown> {
  if (!argumentsText) return {}
  try {
    const parsed = JSON.parse(argumentsText) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    return {}
  }
  return {}
}

async function writeTextBlock(stream: SSEStream, index: number, text: string) {
  await stream.writeSSE({
    event: "content_block_start",
    data: JSON.stringify({
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    }),
  })
  await stream.writeSSE({
    event: "content_block_delta",
    data: JSON.stringify({
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text },
    }),
  })
  await stream.writeSSE({
    event: "content_block_stop",
    data: JSON.stringify({ type: "content_block_stop", index }),
  })
}

async function writeToolUseBlock(
  stream: SSEStream,
  index: number,
  block: AnthropicToolUseBlock,
) {
  await stream.writeSSE({
    event: "content_block_start",
    data: JSON.stringify({
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: {},
      },
    }),
  })
  await stream.writeSSE({
    event: "content_block_delta",
    data: JSON.stringify({
      type: "content_block_delta",
      index,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(block.input),
      },
    }),
  })
  await stream.writeSSE({
    event: "content_block_stop",
    data: JSON.stringify({ type: "content_block_stop", index }),
  })
}
