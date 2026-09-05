import consola from "consola"

import { state } from "~/lib/state"
import {
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  type ContentPart,
  type Message,
  type TextPart,
  type Tool,
  type ToolCall,
} from "~/services/copilot/create-chat-completions"

import {
  type AnthropicAssistantContentBlock,
  type AnthropicAssistantMessage,
  type AnthropicDocumentBlock,
  type AnthropicMessage,
  type AnthropicMessagesPayload,
  type AnthropicResponse,
  type AnthropicTextBlock,
  type AnthropicTool,
  type AnthropicToolResultBlock,
  type AnthropicToolUseBlock,
  type AnthropicUserContentBlock,
  type AnthropicUserMessage,
} from "./anthropic-types"
import { translateReasoningEffort } from "./reasoning-effort"
import { mapOpenAIStopReasonToAnthropic } from "./utils"

// Payload translation

export function translateToOpenAI(
  payload: AnthropicMessagesPayload,
): ChatCompletionsPayload {
  const messages = stripTrailingAssistantPrefill(
    translateAnthropicMessagesToOpenAI(payload.messages, payload.system),
  )
  const model = translateModelName(payload.model)

  return {
    model,
    messages,
    max_tokens: payload.max_tokens,
    stop: payload.stop_sequences,
    stream: payload.stream,
    temperature: payload.temperature,
    top_p: payload.top_p,
    user: payload.metadata?.user_id,
    tools: translateAnthropicToolsToOpenAI(payload.tools),
    tool_choice: translateAnthropicToolChoiceToOpenAI(payload.tool_choice),
    thinking: translateAnthropicThinkingToOpenAI(payload.thinking),
    reasoning_effort: translateReasoningEffort(
      model,
      payload.output_config?.effort,
    ),
  }
}

function stripTrailingAssistantPrefill(
  messages: Array<Message>,
): Array<Message> {
  let end = messages.length
  while (end > 0 && messages[end - 1].role === "assistant") {
    end--
  }

  if (end === messages.length) {
    return messages
  }

  consola.warn(
    `Stripped ${messages.length - end} trailing assistant prefill message(s) unsupported by Copilot chat completions`,
  )
  return messages.slice(0, end)
}

/**
 * Pre-process the Anthropic payload to handle async / proxy-side concerns
 * (currently: PDF document block extraction). Returns a new payload with
 * `document` blocks replaced by extracted-text blocks.
 *
 * Throws HTTPError (Anthropic-shaped) on PDF extraction failure.
 */
export async function preprocessAnthropicPayload(
  payload: AnthropicMessagesPayload,
): Promise<AnthropicMessagesPayload> {
  // Fast path: no document blocks anywhere.
  const hasDocuments = payload.messages.some(
    (m) =>
      Array.isArray(m.content) && m.content.some((b) => b.type === "document"),
  )
  if (!hasDocuments) return payload

  const newMessages: Array<AnthropicMessage> = []
  for (const msg of payload.messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) {
      newMessages.push(msg)
      continue
    }
    const newContent: Array<AnthropicUserContentBlock> = []
    for (const block of msg.content) {
      if (block.type === "document") {
        newContent.push(...(await extractDocumentBlock(block)))
      } else {
        newContent.push(block)
      }
    }
    newMessages.push({ role: "user", content: newContent })
  }
  return { ...payload, messages: newMessages }
}

async function extractDocumentBlock(
  block: AnthropicDocumentBlock,
): Promise<Array<AnthropicTextBlock>> {
  // Plain-text document source — just inline.
  if (block.source.type === "text") {
    return [
      {
        type: "text",
        text: documentHeader(block) + block.source.data,
      },
    ]
  }

  // URL document source — Copilot can't fetch URLs; skip with note.
  if (block.source.type === "url") {
    return [
      {
        type: "text",
        text:
          documentHeader(block)
          + `[document at ${block.source.url} not inlined — proxy does not fetch external URLs]`,
      },
    ]
  }

  // base64 PDF — extract via pdf-parse.
  const { extractPdfText } = await import("~/lib/pdf")
  const extracted = await extractPdfText(block.source.data)
  return [
    {
      type: "text",
      text:
        documentHeader(block)
        + `[Extracted text from PDF (${extracted.pageCount} page${extracted.pageCount === 1 ? "" : "s"}${extracted.truncated ? ", truncated" : ""}):]\n\n`
        + extracted.text,
    },
  ]
}

function documentHeader(block: AnthropicDocumentBlock): string {
  const parts: Array<string> = []
  if (block.title) parts.push(`Document: ${block.title}`)
  if (block.context) parts.push(`Context: ${block.context}`)
  return parts.length > 0 ? parts.join("\n") + "\n\n" : ""
}

// Static fallback mappings, used when state.models hasn't loaded or the
// dynamic resolver can't find a family match.
const MODEL_NAME_FALLBACK: Record<string, string> = {
  haiku: "claude-haiku-4.5",
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-5",
}

const LEGACY_OPUS_FALLBACK = "claude-opus-4.8"

const CLAUDE_FAMILIES = ["opus", "sonnet", "haiku"] as const
type ClaudeFamily = (typeof CLAUDE_FAMILIES)[number]

/** Detect which Claude family a requested model name belongs to.
 *  Handles all the shapes Claude Code emits: bare (`claude-opus-4-5`),
 *  dated (`claude-opus-4-5-20251101`), AWS (`claude-opus-4-5@20251101`),
 *  Bedrock (`claude-opus-4-5-20251101-v1:0`), short alias (`opus`), etc. */
function detectFamily(model: string): ClaudeFamily | null {
  const lower = model.toLowerCase()
  for (const family of CLAUDE_FAMILIES) {
    if (lower.includes(family)) return family
  }
  return null
}

/** Parse a numeric version tuple from a Copilot model id like
 *  `claude-opus-4.7` → [4, 7] or `claude-sonnet-5` → [5, 0].
 *  Returns [0, 0] if no version found. */
function parseCopilotVersion(id: string): [number, number] {
  const match =
    /(?:opus|sonnet|haiku)-(\d{1,2})(?:[.-](\d{1,2}))?(?:$|[-_.])/i.exec(id)
  if (!match) return [0, 0]
  return [Number(match[1]), match[2] ? Number(match[2]) : 0]
}

/** Pick the best Copilot model in a family (and optionally a major version).
 *  Highest version wins; among equal versions, prefer the `-1m` variant. */
function pickLatestCopilotModel(
  family: ClaudeFamily,
  majorVersion?: number,
): string | null {
  const candidates =
    state.models?.data.filter(
      (m) =>
        m.id.toLowerCase().includes(family)
        && (majorVersion === undefined
          || parseCopilotVersion(m.id)[0] === majorVersion),
    ) ?? []
  if (candidates.length === 0) return null

  let best = candidates[0]
  let bestVersion = parseCopilotVersion(best.id)
  let bestIs1m = best.id.includes("-1m")

  for (const m of candidates.slice(1)) {
    const v = parseCopilotVersion(m.id)
    const is1m = m.id.includes("-1m")
    const newer =
      v[0] > bestVersion[0]
      || (v[0] === bestVersion[0] && v[1] > bestVersion[1])
    const sameVersionPrefer1m =
      v[0] === bestVersion[0] && v[1] === bestVersion[1] && is1m && !bestIs1m
    if (newer || sameVersionPrefer1m) {
      best = m
      bestVersion = v
      bestIs1m = is1m
    }
  }
  return best.id
}

function parseRequestedClaudeVersion(
  model: string,
  family: ClaudeFamily,
): [number, number] | null {
  const match = new RegExp(
    `${family}-(\\d{1,2})(?:[.-](\\d{1,2}))?(?:$|[-@:.])`,
  ).exec(model.toLowerCase())
  if (!match) return null
  return [Number(match[1]), match[2] ? Number(match[2]) : 0]
}

function isCopilotClaudeModelId(model: string): boolean {
  const match =
    /^claude-(?:opus|sonnet|haiku)-(\d{1,2})(?:\.(\d{1,2})(?:-.+)?)?$/i.exec(
      model,
    )
  if (!match) return false
  return Boolean(match[2]) || Number(match[1]) >= 5
}

function unadvertisedClaudeModelFallback(
  model: string,
  family: ClaudeFamily,
  version: [number, number],
): string | null {
  if (family === "opus" && version[0] === 5 && version[1] === 0) {
    return MODEL_NAME_FALLBACK.opus
  }
  if (family === "opus" && version[0] === 4) return LEGACY_OPUS_FALLBACK
  if (!state.models && isCopilotClaudeModelId(model)) return model
  return null
}

/** Pick the Copilot model matching the user-requested Claude version.
 *  Among equal versions, prefer the `-1m` variant. */
function pickMatchingCopilotModel(
  family: ClaudeFamily,
  version: [number, number],
): string | null {
  const candidates =
    state.models?.data.filter((m) => {
      const candidateVersion = parseCopilotVersion(m.id)
      return (
        m.id.toLowerCase().includes(family)
        && candidateVersion[0] === version[0]
        && candidateVersion[1] === version[1]
      )
    }) ?? []
  if (candidates.length === 0) return null

  let best = candidates[0]
  let bestIs1m = best.id.includes("-1m")

  for (const m of candidates.slice(1)) {
    const is1m = m.id.includes("-1m")
    if (is1m && !bestIs1m) {
      best = m
      bestIs1m = is1m
    }
  }
  return best.id
}

function translateModelName(model: string): string {
  // Claude Code uses Anthropic model IDs (e.g. claude-opus-4-5-20251101);
  // Copilot uses version-only names (e.g. claude-opus-4.7). Preserve the
  // version Claude Code requested instead of upgrading a family to latest.

  const family = detectFamily(model)
  if (family) {
    const override = process.env[`COPILOT_OVERRIDE_${family.toUpperCase()}`]
    if (override) return override
  }

  // 1. Already a valid Copilot model id → pass through unchanged.
  if (state.models?.data.some((m) => m.id === model)) {
    return model
  }

  // 2. Exact short aliases use pinned defaults. These come from user/tool
  //    settings, so do not reinterpret them as "latest family member".
  if (MODEL_NAME_FALLBACK[model]) {
    return MODEL_NAME_FALLBACK[model]
  }

  // 3. For explicit Claude version names, use the matching Copilot version
  //    when available. If the input is already a Copilot-shaped dotted id,
  //    preserve it even when state.models is not loaded yet.
  if (family) {
    const requestedVersion = parseRequestedClaudeVersion(model, family)
    if (requestedVersion) {
      const matching = pickMatchingCopilotModel(family, requestedVersion)
      if (matching) return matching
      const sameMajor = pickLatestCopilotModel(family, requestedVersion[0])
      if (sameMajor) return sameMajor
      const fallback = unadvertisedClaudeModelFallback(
        model,
        family,
        requestedVersion,
      )
      if (fallback) return fallback
    }

    const latest = pickLatestCopilotModel(family)
    if (latest) return latest

    return MODEL_NAME_FALLBACK[family]
  }

  return model
}

function translateAnthropicMessagesToOpenAI(
  anthropicMessages: Array<AnthropicMessage>,
  system: string | Array<AnthropicTextBlock> | undefined,
): Array<Message> {
  const systemMessages = handleSystemPrompt(system)

  const otherMessages = anthropicMessages.flatMap((message) =>
    message.role === "user" ?
      handleUserMessage(message)
    : handleAssistantMessage(message),
  )

  return [...systemMessages, ...otherMessages]
}

// Reserved keywords that GitHub Copilot API blocks in system prompts
// These will be completely removed from system prompts (case-insensitive)
const RESERVED_KEYWORD_PATTERNS = [
  /x-anthropic-billing-header/gi,
  /anthropic-billing-header/gi,
  /x-anthropic-/gi,
]

function sanitizeSystemPrompt(text: string): string {
  let sanitized = text
  for (const pattern of RESERVED_KEYWORD_PATTERNS) {
    sanitized = sanitized.replaceAll(pattern, "")
  }
  return sanitized
}

function handleSystemPrompt(
  system: string | Array<AnthropicTextBlock> | undefined,
): Array<Message> {
  if (!system) {
    return []
  }

  if (typeof system === "string") {
    return [{ role: "system", content: sanitizeSystemPrompt(system) }]
  } else {
    const systemText = system.map((block) => block.text).join("\n\n")
    return [{ role: "system", content: sanitizeSystemPrompt(systemText) }]
  }
}

function handleUserMessage(message: AnthropicUserMessage): Array<Message> {
  const newMessages: Array<Message> = []

  if (Array.isArray(message.content)) {
    const toolResultBlocks = message.content.filter(
      (block): block is AnthropicToolResultBlock =>
        block.type === "tool_result",
    )
    const otherBlocks = message.content.filter(
      (block) => block.type !== "tool_result",
    )

    // Tool results must come first to maintain protocol: tool_use -> tool_result -> user
    for (const block of toolResultBlocks) {
      newMessages.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: mapContent(block.content),
      })
    }

    if (otherBlocks.length > 0) {
      newMessages.push({
        role: "user",
        content: mapContent(otherBlocks),
      })
    }
  } else {
    newMessages.push({
      role: "user",
      content: mapContent(message.content),
    })
  }

  return newMessages
}

function handleAssistantMessage(
  message: AnthropicAssistantMessage,
): Array<Message> {
  if (!Array.isArray(message.content)) {
    return [
      {
        role: "assistant",
        content: mapContent(message.content),
      },
    ]
  }

  const toolUseBlocks = message.content.filter(
    (block): block is AnthropicToolUseBlock => block.type === "tool_use",
  )

  const textBlocks = message.content.filter(
    (block): block is AnthropicTextBlock => block.type === "text",
  )

  // Thinking blocks have signed-by-Anthropic semantics that Copilot can't
  // verify or replay. Promoting their content to plain text would destroy
  // the assistant turn semantics (the model would treat its own private
  // reasoning as visible text). Drop them cleanly on the request side.
  const allTextContent = textBlocks.map((b) => b.text).join("\n\n")

  return toolUseBlocks.length > 0 ?
      [
        {
          role: "assistant",
          content: allTextContent || null,
          tool_calls: toolUseBlocks.map((toolUse) => ({
            id: toolUse.id,
            type: "function",
            function: {
              name: toolUse.name,
              arguments: JSON.stringify(toolUse.input),
            },
          })),
        },
      ]
    : [
        {
          role: "assistant",
          content: mapContent(message.content),
        },
      ]
}

function mapContent(
  content:
    | string
    | Array<AnthropicUserContentBlock | AnthropicAssistantContentBlock>,
): string | Array<ContentPart> | null {
  if (typeof content === "string") {
    return content
  }
  if (!Array.isArray(content)) {
    return null
  }

  const hasImage = content.some((block) => block.type === "image")
  if (!hasImage) {
    return content
      .filter((block): block is AnthropicTextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n\n")
  }

  const contentParts: Array<ContentPart> = []
  for (const block of content) {
    switch (block.type) {
      case "text": {
        contentParts.push({ type: "text", text: block.text })

        break
      }
      // Thinking blocks dropped — see handleAssistantMessage rationale.
      case "image": {
        contentParts.push({
          type: "image_url",
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`,
          },
        })

        break
      }
      // No default
    }
  }
  return contentParts
}

function translateAnthropicToolsToOpenAI(
  anthropicTools: Array<AnthropicTool> | undefined,
): Array<Tool> | undefined {
  if (!anthropicTools) {
    return undefined
  }
  return anthropicTools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }))
}

/**
 * Map Anthropic `thinking` to the Copilot-compatible format.
 * Anthropic uses `'enabled'` and `'adaptive'`; Copilot only accepts
 * `'enabled'` or `'disabled'`. Both `'enabled'` and `'adaptive'` map to
 * `'enabled'` since they both request extended thinking.
 */
function translateAnthropicThinkingToOpenAI(
  thinking: AnthropicMessagesPayload["thinking"],
): ChatCompletionsPayload["thinking"] {
  if (!thinking) return undefined
  // Copilot only supports 'enabled' | 'disabled' — map 'adaptive' to 'enabled'
  return { type: "enabled" }
}

function translateAnthropicToolChoiceToOpenAI(
  anthropicToolChoice: AnthropicMessagesPayload["tool_choice"],
): ChatCompletionsPayload["tool_choice"] {
  if (!anthropicToolChoice) {
    return undefined
  }

  switch (anthropicToolChoice.type) {
    case "auto": {
      return "auto"
    }
    case "any": {
      return "required"
    }
    case "tool": {
      if (anthropicToolChoice.name) {
        return {
          type: "function",
          function: { name: anthropicToolChoice.name },
        }
      }
      return undefined
    }
    case "none": {
      return "none"
    }
    default: {
      return undefined
    }
  }
}

// Response translation

// eslint-disable-next-line complexity
export function translateToAnthropic(
  response: ChatCompletionResponse,
  /** Original client-requested model id, echoed back so Claude Code displays
   *  the model the user asked for rather than Copilot's internal id. */
  clientModel?: string,
): AnthropicResponse {
  // Merge content from all choices
  const allTextBlocks: Array<AnthropicTextBlock> = []
  const allToolUseBlocks: Array<AnthropicToolUseBlock> = []
  let stopReason: "stop" | "length" | "tool_calls" | "content_filter" | null =
    null // default
  stopReason = response.choices[0]?.finish_reason ?? stopReason

  // Process all choices to extract text and tool use blocks
  for (const choice of response.choices) {
    const textBlocks = getAnthropicTextBlocks(choice.message.content)
    const toolUseBlocks = getAnthropicToolUseBlocks(choice.message.tool_calls)

    allTextBlocks.push(...textBlocks)
    allToolUseBlocks.push(...toolUseBlocks)

    // Use the finish_reason from the first choice, or prioritize tool_calls
    if (choice.finish_reason === "tool_calls" || stopReason === "stop") {
      stopReason = choice.finish_reason
    }
  }

  // Note: GitHub Copilot doesn't generate thinking blocks, so we don't include them in responses

  return {
    id: response.id,
    type: "message",
    role: "assistant",
    model: clientModel ?? response.model,
    content: [...allTextBlocks, ...allToolUseBlocks],
    stop_reason: mapOpenAIStopReasonToAnthropic(stopReason),
    stop_sequence: null,
    usage: {
      input_tokens:
        (response.usage?.prompt_tokens ?? 0)
        - (response.usage?.prompt_tokens_details?.cached_tokens ?? 0),
      output_tokens: response.usage?.completion_tokens ?? 0,
      ...(response.usage?.prompt_tokens_details?.cached_tokens
        !== undefined && {
        cache_read_input_tokens:
          response.usage.prompt_tokens_details.cached_tokens,
      }),
    },
  }
}

function getAnthropicTextBlocks(
  messageContent: Message["content"],
): Array<AnthropicTextBlock> {
  if (typeof messageContent === "string") {
    return [{ type: "text", text: messageContent }]
  }

  if (Array.isArray(messageContent)) {
    return messageContent
      .filter((part): part is TextPart => part.type === "text")
      .map((part) => ({ type: "text", text: part.text }))
  }

  return []
}

function getAnthropicToolUseBlocks(
  toolCalls: Array<ToolCall> | undefined,
): Array<AnthropicToolUseBlock> {
  if (!toolCalls) {
    return []
  }
  return toolCalls.map((toolCall) => {
    let input: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(toolCall.function.arguments) as unknown
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        input = parsed as Record<string, unknown>
      }
    } catch {
      // Copilot can emit malformed JSON for tool args (especially mid-stream
      // truncation or partial outputs). Fall back to an empty object so the
      // assistant turn is at least well-formed; Claude Code will surface the
      // missing args via tool execution failure rather than a hard crash.
    }
    return {
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.function.name,
      input,
    }
  })
}
