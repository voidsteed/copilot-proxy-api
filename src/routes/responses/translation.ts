import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ContentPart,
  Message,
  Tool,
} from "~/services/copilot/create-chat-completions"

import type {
  ResponsesApiRequest,
  ResponsesApiResponse,
  ResponsesContentPart,
  ResponsesInputItem,
  ResponsesOutputItem,
} from "./types"

/**
 * Translate Responses API request to Chat Completions format
 */
export function translateResponsesToChat(
  request: ResponsesApiRequest,
): ChatCompletionsPayload {
  const messages: Array<Message> = []

  // Handle instructions as system message
  if (request.instructions) {
    messages.push({
      role: "system",
      content: request.instructions,
    })
  }

  // Handle input - can be string or array of items
  if (typeof request.input === "string") {
    messages.push({
      role: "user",
      content: request.input,
    })
  } else if (Array.isArray(request.input)) {
    for (const item of request.input) {
      const message = translateInputItem(item)
      if (message) {
        messages.push(message)
      }
    }
  }

  // Translate tools
  const tools = translateTools(request.tools)

  // Translate tool_choice
  let toolChoice: ChatCompletionsPayload["tool_choice"]
  if (request.tool_choice) {
    if (typeof request.tool_choice === "string") {
      toolChoice = request.tool_choice as "auto" | "none" | "required"
    } else if (
      request.tool_choice.type === "function"
      && request.tool_choice.function?.name
    ) {
      toolChoice = {
        type: "function",
        function: { name: request.tool_choice.function.name },
      }
    }
  }

  return {
    model: request.model,
    messages,
    max_tokens: request.max_output_tokens,
    temperature: request.temperature,
    top_p: request.top_p,
    stream: request.stream,
    tools,
    tool_choice: toolChoice,
  }
}

function translateInputItem(item: ResponsesInputItem): Message | null {
  // Handle tool_result type
  if (item.type === "tool_result" && item.tool_call_id) {
    return {
      role: "tool",
      tool_call_id: item.tool_call_id,
      content:
        item.output ?? (typeof item.content === "string" ? item.content : ""),
    }
  }

  // Handle regular message
  const content = translateContent(item.content)
  if (!content) return null

  // Map developer role to system
  const role = item.role === "developer" ? "system" : item.role

  return {
    role,
    content,
  }
}

function translateContent(
  content: string | Array<ResponsesContentPart> | undefined,
): string | Array<ContentPart> | null {
  if (!content) return null
  if (typeof content === "string") return content

  const textParts = content
    .filter(
      (part): part is ResponsesContentPart & { text: string } =>
        (part.type === "input_text" || part.type === "output_text")
        && Boolean(part.text),
    )
    .map((part) => part.text)

  return textParts.length > 0 ? textParts.join("\n") : null
}

function translateTools(
  tools: ResponsesApiRequest["tools"],
): Array<Tool> | undefined {
  if (!tools || tools.length === 0) return undefined

  const result: Array<Tool> = []
  for (const tool of tools) {
    if (tool.type === "function" && tool.function) {
      result.push({
        type: "function",
        function: {
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters ?? {},
        },
      })
    }
  }
  return result.length > 0 ? result : undefined
}

/**
 * Translate Chat Completions response to Responses API format
 */
export function translateChatToResponses(
  response: ChatCompletionResponse,
  model: string,
): ResponsesApiResponse {
  const output: Array<ResponsesOutputItem> = []
  let outputText = ""

  for (const choice of response.choices) {
    const message = choice.message

    // Handle text content
    if (message.content) {
      const textContent = extractTextContent(message.content)

      if (textContent) {
        outputText = textContent
        output.push({
          id: `msg_${response.id}`,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: textContent,
            },
          ],
        })
      }
    }

    // Handle tool calls
    if (message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        output.push({
          id: `fc_${toolCall.id}`,
          type: "function_call",
          status: "completed",
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
          call_id: toolCall.id,
        })
      }
    }
  }

  return {
    id: response.id,
    object: "response",
    created_at: response.created,
    model: response.model || model,
    output,
    output_text: outputText,
    usage: translateUsage(response.usage),
    status: "completed",
  }
}

function translateUsage(
  usage: ChatCompletionResponse["usage"],
): ResponsesApiResponse["usage"] {
  if (!usage) return undefined

  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.prompt_tokens + usage.completion_tokens,
  }
}

function extractTextContent(
  content: string | Array<ContentPart> | null,
): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  return content
    .filter(
      (p): p is ContentPart & { type: "text"; text: string } =>
        p.type === "text" && "text" in p,
    )
    .map((p) => p.text)
    .join("")
}
