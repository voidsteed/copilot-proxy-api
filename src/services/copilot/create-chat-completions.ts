import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { prepareChatCompletionsWireRequest } from "~/lib/context-manager"
import {
  copilotFetch,
  isLikelyContextOverflowTimeout,
} from "~/lib/copilot-fetch"
import { HTTPError } from "~/lib/error"
import {
  createPromptTooLongError,
  matchContextOverflowError,
} from "~/lib/prompt-too-long"
import { state } from "~/lib/state"

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
  signal?: AbortSignal,
) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const isAgentCall = payload.messages.some(
    (msg) => msg.role === "assistant" || msg.role === "tool",
  )
  const model = state.models?.data.find((m) => m.id === payload.model)
  const wireRequest = prepareChatCompletionsWireRequest(
    normalizeTokenLimitParameter(payload),
    model,
  )

  const headers: Record<string, string> = {
    ...copilotHeaders(state, wireRequest.enableVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
  }

  const maxOutputTokens =
    wireRequest.payload.max_completion_tokens
    ?? wireRequest.payload.max_tokens
    ?? 0

  consola.debug(
    `Sending payload: ${wireRequest.utf8Bytes} bytes, ${wireRequest.payload.messages.length} messages, model: ${wireRequest.payload.model}`,
  )

  let response: Response
  try {
    response = await copilotFetch(`${copilotBaseUrl(state)}/chat/completions`, {
      method: "POST",
      headers,
      body: wireRequest.body,
      signal,
    })
  } catch (error) {
    if (isLikelyContextOverflowTimeout(error, wireRequest.utf8Bytes)) {
      throw createPromptTooLongError({
        model: wireRequest.payload.model,
        maxOutputTokens,
        bodyBytes: wireRequest.utf8Bytes,
      })
    }
    throw error
  }

  if (!response.ok) {
    const errorBody = await response.text()
    const errorCode = extractSafeErrorCode(errorBody)
    consola.error(
      `Failed to create chat completions - Status: ${response.status} ${response.statusText}${errorCode ? ` (${errorCode})` : ""}`,
    )
    consola.error(`Request payload size: ${wireRequest.utf8Bytes} bytes`)

    const overflowError = matchContextOverflowError({
      status: response.status,
      errorBody,
      bodyBytes: wireRequest.utf8Bytes,
      model: wireRequest.payload.model,
      maxOutputTokens,
    })
    if (overflowError) throw overflowError

    throw new HTTPError(
      "Failed to create chat completions",
      new Response(errorBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
    )
  }

  if (payload.stream) {
    return cancellableEvents(response, signal)
  }

  return (await response.json()) as ChatCompletionResponse
}

function cancellableEvents(response: Response, signal?: AbortSignal) {
  const reader = response.body?.getReader()
  if (!reader) return events(response, signal)

  let cleanup: Promise<void> | undefined
  const cancel = () => {
    cleanup ??= (async () => {
      signal?.removeEventListener("abort", abort)
      try {
        await reader.cancel(signal?.reason)
      } finally {
        reader.releaseLock()
      }
    })()
    return cleanup
  }
  const abort = () => {
    void cancel().catch(() => undefined)
  }
  signal?.addEventListener("abort", abort, { once: true })
  if (signal?.aborted) abort()

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read()
        if (result.done) {
          controller.close()
          return
        }
        const chunk: unknown = result.value
        if (!(chunk instanceof Uint8Array))
          throw new TypeError("Invalid upstream response chunk")
        controller.enqueue(chunk)
      } catch (error) {
        controller.error(error)
      }
    },
    cancel,
  })

  const iterator = (async function* () {
    try {
      for await (const event of events(new Response(body), signal)) {
        signal?.throwIfAborted()
        yield event
      }
      signal?.throwIfAborted()
    } finally {
      await cancel()
    }
  })()
  const returnIterator = iterator.return.bind(iterator)
  const throwIterator = iterator.throw.bind(iterator)
  iterator.return = async (value) => {
    await cancel()
    return returnIterator(value)
  }
  iterator.throw = async (error: unknown) => {
    await cancel()
    return throwIterator(error)
  }
  return iterator
}

// Streaming types

export interface ChatCompletionChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<Choice>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
    completion_tokens_details?: {
      accepted_prediction_tokens: number
      rejected_prediction_tokens: number
    }
  }
}

interface Delta {
  content?: string | null
  role?: "user" | "assistant" | "system" | "tool"
  /** Copilot streams Claude's extended thinking here while it reasons. */
  reasoning_text?: string | null
  /** Signature for the reasoning, sent once when the thinking block ends. */
  reasoning_opaque?: string | null
  tool_calls?: Array<{
    index: number
    id?: string
    type?: "function"
    function?: {
      name?: string
      arguments?: string
    }
  }>
}

interface Choice {
  index: number
  delta: Delta
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
  logprobs: object | null
}

// Non-streaming types

export interface ChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: Array<ChoiceNonStreaming>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
  }
}

interface ResponseMessage {
  role: "assistant"
  content: string | null
  reasoning_text?: string | null
  reasoning_opaque?: string | null
  tool_calls?: Array<ToolCall>
}

interface ChoiceNonStreaming {
  index: number
  message: ResponseMessage
  logprobs: object | null
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter"
}

// Payload types

export interface ChatCompletionsPayload {
  messages: Array<Message>
  model: string
  temperature?: number | null
  top_p?: number | null
  max_tokens?: number | null
  max_completion_tokens?: number | null
  stop?: string | Array<string> | null
  n?: number | null
  stream?: boolean | null

  frequency_penalty?: number | null
  presence_penalty?: number | null
  logit_bias?: Record<string, number> | null
  logprobs?: boolean | null
  response_format?: { type: "json_object" } | null
  seed?: number | null
  thinking?: { type: "enabled" | "disabled" } | null
  reasoning_effort?: "low" | "medium" | "high" | "xhigh" | "max" | null
  tools?: Array<Tool> | null
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } }
    | null
  user?: string | null
}

const SAFE_ERROR_CODE = /^[\w.-]{1,128}$/

function extractSafeErrorCode(errorBody: string): string | undefined {
  try {
    const parsed = JSON.parse(errorBody) as { error?: { code?: unknown } }
    const code = parsed.error?.code
    return typeof code === "string" && SAFE_ERROR_CODE.test(code) ?
        code
      : undefined
  } catch {
    return undefined
  }
}

const MAX_COMPLETION_TOKENS_MODEL_PATTERN =
  /^(?:gpt-5(?:[.-]|$)|o\d+(?:[.-]|$))/i

function normalizeTokenLimitParameter(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  const modelFamily = state.models?.data.find(
    (model) => model.id === payload.model,
  )?.capabilities.family
  const requiresMaxCompletionTokens = [payload.model, modelFamily].some(
    (model) =>
      model !== undefined && MAX_COMPLETION_TOKENS_MODEL_PATTERN.test(model),
  )

  if (!requiresMaxCompletionTokens) return payload

  const normalized = { ...payload }
  const maxTokens = normalized.max_tokens
  delete normalized.max_tokens

  if (
    normalized.max_completion_tokens === undefined
    || normalized.max_completion_tokens === null
  ) {
    normalized.max_completion_tokens = maxTokens
  }

  return normalized
}

export interface Tool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool" | "developer"
  content: string | Array<ContentPart> | null

  name?: string
  tool_calls?: Array<ToolCall>
  tool_call_id?: string
  /** Prior Claude reasoning, sent back so the model can continue from it. */
  reasoning_text?: string
  /** Signature Copilot issued with that reasoning (`reasoning_opaque`). */
  reasoning_opaque?: string
}

export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type ContentPart = TextPart | ImagePart

export interface TextPart {
  type: "text"
  text: string
}

export interface ImagePart {
  type: "image_url"
  image_url: {
    url: string
    detail?: "low" | "high" | "auto"
  }
}
