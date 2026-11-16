import type {
  ChatCompletionsPayload,
  ContentPart,
  Message,
  ToolCall,
} from "~/services/copilot/create-chat-completions"
import type { Model } from "~/services/copilot/get-models"

import {
  argumentsSchema,
  GeminiError,
  type GenerateRequest,
  type Part,
  type UpstreamResponse,
} from "./schemas"

type Content = GenerateRequest["contents"][number]
type PendingCall = { id: string; name: string }
const efforts = { LOW: "low", MEDIUM: "medium", HIGH: "high" } satisfies Record<
  string,
  "low" | "medium" | "high"
>

function validateAssistantOrder(content: Content) {
  let phase: "thought" | "text" | "call" = "thought"
  for (const part of content.parts) {
    if ("functionCall" in part) phase = "call"
    else if ("text" in part && part.text.length > 0) {
      if (phase === "call")
        throw new GeminiError(
          "Text after functionCall cannot be represented upstream",
        )
      if (part.thought && phase === "text")
        throw new GeminiError(
          "Interleaved reasoning cannot be represented upstream",
        )
      if (!part.thought) phase = "text"
    }
  }
}
function validateUserOrder(part: Part, pending: Array<PendingCall>) {
  if (pending.length > 0 && !("functionResponse" in part))
    throw new GeminiError(
      "Resolve pending function calls before adding user parts",
    )
}
function assistantMessage(
  content: Content,
  pending: Array<PendingCall>,
  nextId: () => string,
): Message {
  validateAssistantOrder(content)
  const text: Array<string> = []
  const thoughts: Array<string> = []
  const signatures = new Set<string>()
  const calls: Array<ToolCall> = []
  for (const part of content.parts) {
    if ("thoughtSignature" in part && part.thoughtSignature !== undefined)
      signatures.add(part.thoughtSignature)
    if ("text" in part) (part.thought ? thoughts : text).push(part.text)
    else if ("functionCall" in part) {
      const call = part.functionCall
      const id = call.id ?? nextId()
      if (pending.some((item) => item.id === id))
        throw new GeminiError("Duplicate function call ID")
      pending.push({ id, name: call.name })
      calls.push({
        id,
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(call.args ?? {}),
        },
      })
    } else
      throw new GeminiError(
        "Model content supports only text and functionCall parts",
      )
  }
  if (signatures.size > 1)
    throw new GeminiError(
      "Multiple distinct thought signatures cannot be represented upstream",
    )
  const message: Message = { role: "assistant", content: text.join("") || null }
  if (thoughts.length > 0) message.reasoning_text = thoughts.join("")
  if (signatures.size > 0)
    message.reasoning_opaque = signatures.values().next().value
  if (calls.length > 0) message.tool_calls = calls
  return message
}
function userMessages(
  content: Content,
  pending: Array<PendingCall>,
  vision: boolean,
): Array<Message> {
  const messages: Array<Message> = []
  let parts: Array<ContentPart> = []
  const flush = () => {
    if (parts.length === 0) return
    const onlyText = parts.every((part) => part.type === "text")
    messages.push({
      role: "user",
      content:
        onlyText ?
          parts.map((part) => (part.type === "text" ? part.text : "")).join("")
        : parts,
    })
    parts = []
  }
  for (const part of content.parts) {
    validateUserOrder(part, pending)
    if ("text" in part && !part.thought && part.thoughtSignature === undefined)
      parts.push({ type: "text", text: part.text })
    else if ("inlineData" in part) {
      if (!vision)
        throw new GeminiError("Selected model does not support images")
      parts.push({
        type: "image_url",
        image_url: {
          url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
        },
      })
    } else if ("functionResponse" in part) {
      flush()
      const result = part.functionResponse
      const index =
        result.id === undefined ?
          0
        : pending.findIndex((call) => call.id === result.id)
      const call = pending[index]
      if (index < 0 || pending.length === 0 || call.name !== result.name)
        throw new GeminiError(
          "Function response must match a pending call in order or by ID",
        )
      pending.splice(index, 1)
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result.response),
      })
    } else
      throw new GeminiError(
        "User content supports text, inline images, and functionResponse parts",
      )
  }
  flush()
  return messages
}
function translateMessages(
  request: GenerateRequest,
  model: Model,
): Array<Message> {
  const messages: Array<Message> = []
  const pending: Array<PendingCall> = []
  let sequence = 0
  const usedIds = new Set(
    request.contents.flatMap((content) =>
      content.parts.flatMap((part) =>
        "functionCall" in part && part.functionCall.id ?
          [part.functionCall.id]
        : [],
      ),
    ),
  )
  const nextId = () => {
    let id: string
    do {
      id = `gemini_call_${sequence++}`
    } while (usedIds.has(id))
    usedIds.add(id)
    return id
  }
  if (request.systemInstruction)
    messages.push({
      role: "system",
      content: request.systemInstruction.parts
        .map((part) => part.text)
        .join("\n"),
    })
  for (const content of request.contents) {
    if (content.parts.every((part) => "functionResponse" in part))
      messages.push(...userMessages(content, pending, false))
    else if (content.role === "model") {
      if (pending.length > 0)
        throw new GeminiError(
          "Resolve prior function calls before another model turn",
        )
      messages.push(assistantMessage(content, pending, nextId))
    } else
      messages.push(
        ...userMessages(
          content,
          pending,
          model.capabilities.supports.vision === true,
        ),
      )
  }
  return messages
}
function toolChoice(
  request: GenerateRequest,
): ChatCompletionsPayload["tool_choice"] {
  const config = request.toolConfig?.functionCallingConfig
  if (!config) return undefined
  const names = config.allowedFunctionNames
  if (names?.length) {
    if (config.mode !== "ANY" || names.length !== 1)
      throw new GeminiError(
        "allowedFunctionNames requires ANY mode and exactly one name",
      )
    if (
      !request.tools?.some((tool) =>
        tool.functionDeclarations.some((fn) => fn.name === names[0]),
      )
    )
      throw new GeminiError("Allowed function must be declared")
    return { type: "function", function: { name: names[0] } }
  }
  switch (config.mode) {
    case "NONE": {
      return "none"
    }
    case "ANY": {
      return "required"
    }
    default: {
      return "auto"
    }
  }
}
function validateCapabilities(
  request: GenerateRequest,
  model: Model,
  stream: boolean,
) {
  const config = request.generationConfig
  const level = config?.thinkingConfig?.thinkingLevel
  const effort = level ? efforts[level] : undefined
  if (effort && !model.capabilities.supports.reasoning_effort?.includes(effort))
    throw new GeminiError("Selected model does not support this thinkingLevel")
  if (stream && !model.capabilities.supports.streaming)
    throw new GeminiError("Selected model does not support streaming")
  if (request.tools?.length && !model.capabilities.supports.tool_calls)
    throw new GeminiError("Selected model does not support tools")
  return effort
}
function translateTools(
  request: GenerateRequest,
): ChatCompletionsPayload["tools"] {
  return request.tools?.flatMap((tool) =>
    tool.functionDeclarations.map((fn) => {
      if (
        fn.parameters
        && /"(?:OBJECT|ARRAY|STRING|NUMBER|INTEGER|BOOLEAN|NULL)"/.test(
          JSON.stringify(fn.parameters),
        )
      )
        throw new GeminiError("Use parametersJsonSchema with JSON Schema types")
      return {
        type: "function",
        function: {
          name: fn.name,
          description: fn.description,
          parameters: fn.parametersJsonSchema
            ?? fn.parameters ?? { type: "object", properties: {} },
        },
      } satisfies NonNullable<ChatCompletionsPayload["tools"]>[number]
    }),
  )
}
function generationOptions(
  config: GenerateRequest["generationConfig"],
): Pick<
  ChatCompletionsPayload,
  | "temperature"
  | "top_p"
  | "stop"
  | "presence_penalty"
  | "frequency_penalty"
  | "response_format"
> {
  return {
    temperature: config?.temperature,
    top_p: config?.topP,
    stop: config?.stopSequences,
    presence_penalty: config?.presencePenalty,
    frequency_penalty: config?.frequencyPenalty,
    response_format:
      config?.responseMimeType === "application/json" ?
        { type: "json_object" }
      : undefined,
  }
}
export function translateRequest(
  request: GenerateRequest,
  model: Model,
  stream: boolean,
): ChatCompletionsPayload {
  const effort = validateCapabilities(request, model, stream)
  const config = request.generationConfig
  const advertisedMaximum = model.capabilities.limits.max_output_tokens
  const maximum =
    (
      advertisedMaximum !== undefined
      && Number.isFinite(advertisedMaximum)
      && advertisedMaximum > 0
    ) ?
      advertisedMaximum
    : undefined
  const requestedMaximum = config?.maxOutputTokens
  return {
    model: model.id,
    messages: translateMessages(request, model),
    stream,
    tools: translateTools(request),
    tool_choice: toolChoice(request),
    max_tokens:
      requestedMaximum !== undefined && maximum !== undefined ?
        Math.min(requestedMaximum, maximum)
      : (requestedMaximum ?? maximum),
    ...generationOptions(config),
    reasoning_effort: effort,
  }
}

export function finishReason(
  reason: string | null | undefined,
): string | undefined {
  switch (reason) {
    case "stop":
    case "tool_calls": {
      return "STOP"
    }
    case "length": {
      return "MAX_TOKENS"
    }
    case "content_filter": {
      return "SAFETY"
    }
    case null:
    case undefined: {
      return undefined
    }
    default: {
      throw new GeminiError(
        "Upstream returned an unsupported finish reason",
        502,
      )
    }
  }
}
export function usageMetadata(usage: UpstreamResponse["usage"]) {
  if (!usage) return undefined
  return {
    promptTokenCount: usage.prompt_tokens,
    candidatesTokenCount: usage.completion_tokens,
    totalTokenCount: usage.total_tokens,
    cachedContentTokenCount: usage.prompt_tokens_details?.cached_tokens,
  }
}
export function functionPart(
  call: { id: string; name: string; arguments: string },
  signature?: string,
): Part {
  let args: unknown
  try {
    args = JSON.parse(call.arguments)
  } catch {
    throw new GeminiError("Upstream returned invalid function arguments", 502)
  }
  const parsed = argumentsSchema.safeParse(args)
  if (!parsed.success)
    throw new GeminiError(
      "Upstream function arguments must be a JSON object",
      502,
    )
  return {
    functionCall: { id: call.id, name: call.name, args: parsed.data },
    ...(signature !== undefined ? { thoughtSignature: signature } : {}),
  }
}
export function translateResponse(
  response: UpstreamResponse,
  includeThoughts: boolean,
) {
  const candidates = response.choices.map((choice) => {
    const message = choice.message
    const parts: Array<Part> = []
    if (includeThoughts && message.reasoning_text)
      parts.push({ text: message.reasoning_text, thought: true })
    if (message.content) parts.push({ text: message.content })
    for (const [index, call] of (message.tool_calls ?? []).entries())
      parts.push(
        functionPart(
          {
            id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          },
          index === 0 ? (message.reasoning_opaque ?? undefined) : undefined,
        ),
      )
    if (
      !message.tool_calls?.length
      && message.reasoning_opaque !== undefined
      && message.reasoning_opaque !== null
    )
      parts.push({ text: "", thoughtSignature: message.reasoning_opaque })
    return {
      index: choice.index,
      content: { role: "model", parts },
      finishReason: finishReason(choice.finish_reason),
    }
  })
  return {
    candidates,
    usageMetadata: usageMetadata(response.usage),
    modelVersion: response.model,
    responseId: response.id,
  }
}
