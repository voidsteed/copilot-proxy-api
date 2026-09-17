import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { ResponsesApiResponse } from "~/routes/responses/types"
import type { Model } from "~/services/copilot/get-models"

import { awaitApproval } from "~/lib/approval"
import {
  fitContext,
  fitUnknownModelContext,
  isPayloadOverUnknownModelCeiling,
} from "~/lib/context-manager"
import { HTTPError } from "~/lib/error"
import { createPromptTooLongError } from "~/lib/prompt-too-long"
import { checkRateLimit } from "~/lib/rate-limit"
import { setRequestLogMetadata } from "~/lib/request-log"
import { state } from "~/lib/state"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionsPayload,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import { createResponses } from "~/services/copilot/create-responses"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  preprocessAnthropicPayload,
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import {
  translateAnthropicMessagesToResponses,
  translateResponsesToAnthropicMessage,
  writeResponsesAsAnthropicStream,
} from "./responses-bridge"
import {
  translateChunkToAnthropicEvents,
  translateErrorToAnthropicErrorEvent,
} from "./stream-translation"

/** Heartbeat interval for SSE keepalive. Claude Code's idle timeout is 90s
 *  (CLAUDE_STREAM_IDLE_TIMEOUT_MS); 15s gives a 6× safety margin. */
const PING_INTERVAL_MS = 15_000
const CHAT_COMPLETIONS_ENDPOINT = "/chat/completions"
const RESPONSES_ENDPOINT = "/responses"

type SSEStream = Parameters<Parameters<typeof streamSSE>[1]>[0]
type ChatCompletionResult = Awaited<ReturnType<typeof createChatCompletions>>
type CreateChatCompletionResponse = () => Promise<ChatCompletionResult>

interface ChatCompletionFlowOptions {
  clientModel: string
  requestId: string
}

interface ResponsesFlowOptions extends ChatCompletionFlowOptions {
  model: string
}

interface ChatCompletionStreamOptions extends ChatCompletionFlowOptions {
  createResponse: CreateChatCompletionResponse
  streamState: AnthropicStreamState
}

interface StreamCleanupOptions {
  error: unknown
  requestId: string
  streamState: AnthropicStreamState
}

function generateRequestId(): string {
  // RFC 4122 v4-ish; sufficient for response correlation.
  return `req_${crypto.randomUUID().replaceAll("-", "")}`
}

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const requestId = c.req.header("x-client-request-id") ?? generateRequestId()
  c.header("request-id", requestId)
  c.header("x-request-id", requestId)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  // Lazy debug logging — JSON.stringify on a large payload is 5-30ms even
  // when debug output is suppressed. Guard with level check (debug = 4).
  if (consola.level >= 4) {
    consola.debug(
      `[${requestId}] Anthropic request payload:`,
      JSON.stringify(anthropicPayload).slice(0, 2000),
    )
  }

  // Preserve the client-requested model name so we can echo it back in the
  // response (Claude Code reads `response.model` for display/telemetry).
  const clientModel = anthropicPayload.model

  // Async preprocessing: PDF document block extraction, etc.
  const preprocessed = await preprocessAnthropicPayload(anthropicPayload)
  const openAIPayload = translateToOpenAI(preprocessed)
  setRequestLogMetadata(c, {
    model: openAIPayload.model,
    effort:
      openAIPayload.reasoning_effort ?? preprocessed.output_config?.effort,
  })
  const model = state.models?.data.find((m) => m.id === openAIPayload.model)

  if (shouldUseResponsesForMessages(model)) {
    return await handleResponsesMessages(c, preprocessed, {
      clientModel,
      model: openAIPayload.model,
      requestId,
    })
  }

  return await handleChatCompletions(c, openAIPayload, {
    clientModel,
    requestId,
  })
}

async function handleChatCompletions(
  c: Context,
  openAIPayload: ChatCompletionsPayload,
  options: ChatCompletionFlowOptions,
) {
  if (consola.level >= 4) {
    consola.debug(
      `[${options.requestId}] Translated OpenAI request payload:`,
      JSON.stringify(openAIPayload),
    )
  }

  // Byte-based context management — fast path returns input unchanged.
  const model = state.models?.data.find((m) => m.id === openAIPayload.model)
  const fittedPayload =
    model ?
      fitContext(openAIPayload, model)
    : fitUnknownModelContext(openAIPayload)

  if (!model && isPayloadOverUnknownModelCeiling(fittedPayload)) {
    throw createPromptTooLongError(
      fittedPayload,
      JSON.stringify(fittedPayload).length,
    )
  }

  if (fittedPayload.messages.length !== openAIPayload.messages.length) {
    consola.info(
      `[${options.requestId}] Context management: ${openAIPayload.messages.length} → ${fittedPayload.messages.length} messages`,
    )
  }

  if (state.manualApprove) {
    await awaitApproval()
  }

  if (fittedPayload.stream) {
    consola.debug(`[${options.requestId}] Streaming response from Copilot`)
    return handleStreamingChatCompletion(
      c,
      () => createChatCompletions(fittedPayload),
      options,
    )
  }

  const response = await createChatCompletions(fittedPayload)
  if (!isNonStreaming(response)) {
    throw new Error("Expected non-streaming response from Copilot")
  }
  return handleNonStreamingChatCompletion(c, response, options)
}

async function handleResponsesMessages(
  c: Context,
  payload: AnthropicMessagesPayload,
  options: ResponsesFlowOptions,
) {
  if (state.manualApprove) {
    await awaitApproval()
  }

  const responsesPayload = translateAnthropicMessagesToResponses(
    payload,
    options.model,
  )

  if (payload.stream) {
    return streamSSE(c, async (stream) => {
      const stopPings = startPings(stream)
      try {
        const response = await createResponses(responsesPayload)
        const body = (await response.json()) as ResponsesApiResponse
        await writeResponsesAsAnthropicStream(stream, body, options.clientModel)
      } catch (error) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify(
            translateErrorToAnthropicErrorEvent(
              error instanceof Error ? error.message : undefined,
            ),
          ),
        })
      } finally {
        stopPings()
      }
    })
  }

  const response = await createResponses(responsesPayload)
  const body = (await response.json()) as ResponsesApiResponse
  return c.json(translateResponsesToAnthropicMessage(body, options.clientModel))
}

function shouldUseResponsesForMessages(model: Model | undefined): boolean {
  if (!model?.supported_endpoints) return false
  return (
    model.supported_endpoints.includes(RESPONSES_ENDPOINT)
    && !model.supported_endpoints.includes(CHAT_COMPLETIONS_ENDPOINT)
  )
}

function handleNonStreamingChatCompletion(
  c: Context,
  response: ChatCompletionResponse,
  options: ChatCompletionFlowOptions,
) {
  if (consola.level >= 4) {
    consola.debug(
      `[${options.requestId}] Non-streaming response from Copilot:`,
      JSON.stringify(response).slice(-400),
    )
  }

  try {
    const anthropicResponse = translateToAnthropic(
      response,
      options.clientModel,
    )
    if (consola.level >= 4) {
      consola.debug(
        `[${options.requestId}] Translated Anthropic response:`,
        JSON.stringify(anthropicResponse),
      )
    }
    return c.json(anthropicResponse)
  } catch (error) {
    return c.json(createTranslationErrorBody(error, options.requestId), 500)
  }
}

function createTranslationErrorBody(error: unknown, requestId: string) {
  consola.error(
    `[${requestId}] Failed to translate non-streaming response:`,
    error,
  )
  return {
    type: "error" as const,
    error: {
      type: "api_error",
      message:
        error instanceof Error ?
          `Translation failed: ${error.message}`
        : "Translation failed",
    },
  }
}

function handleStreamingChatCompletion(
  c: Context,
  createResponse: CreateChatCompletionResponse,
  options: ChatCompletionFlowOptions,
) {
  return streamSSE(c, async (stream) => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }

    const stopPings = startPings(stream)

    try {
      await writePing(stream)
      await forwardChatCompletionStream(stream, {
        ...options,
        createResponse,
        streamState,
      })
    } catch (error) {
      await emitStreamErrorCleanup(stream, {
        error,
        requestId: options.requestId,
        streamState,
      })
    } finally {
      stopPings()
    }
  })
}

function startPings(stream: SSEStream): () => void {
  const pingTimer = setInterval(() => {
    void writePing(stream).catch(() => {})
  }, PING_INTERVAL_MS)

  return () => clearInterval(pingTimer)
}

async function writePing(stream: SSEStream): Promise<void> {
  await stream.writeSSE({
    event: "ping",
    data: JSON.stringify({ type: "ping" }),
  })
}

async function forwardChatCompletionStream(
  stream: SSEStream,
  options: ChatCompletionStreamOptions,
) {
  const response = await options.createResponse()
  if (isNonStreaming(response)) {
    throw new Error("Expected streaming response from Copilot")
  }

  for await (const rawEvent of response) {
    if (rawEvent.data === "[DONE]") break
    if (!rawEvent.data) continue

    const chunk = parseChatCompletionChunk(rawEvent.data, options.requestId)
    if (!chunk) continue

    if (!options.streamState.messageStartSent) chunk.model = options.clientModel

    for (const event of translateChunkToAnthropicEvents(
      chunk,
      options.streamState,
    )) {
      await stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
    }
  }
}

function parseChatCompletionChunk(
  data: string,
  requestId: string,
): ChatCompletionChunk | null {
  try {
    return JSON.parse(data) as ChatCompletionChunk
  } catch (parseError) {
    consola.warn(
      `[${requestId}] Skipping unparseable Copilot chunk:`,
      parseError,
    )
    return null
  }
}

async function emitStreamErrorCleanup(
  stream: SSEStream,
  options: StreamCleanupOptions,
) {
  consola.error(`[${options.requestId}] Streaming error:`, options.error)

  try {
    const errorMessage = await extractStreamErrorMessage(options.error)
    await closeOpenContentBlock(stream, options.streamState)
    await closeStartedMessage(stream, options.streamState)
    await stream.writeSSE({
      event: "error",
      data: JSON.stringify(translateErrorToAnthropicErrorEvent(errorMessage)),
    })
  } catch (cleanupError) {
    consola.error(
      `[${options.requestId}] Failed to emit stream cleanup events:`,
      cleanupError,
    )
  }
}

async function extractStreamErrorMessage(
  error: unknown,
): Promise<string | undefined> {
  if (error instanceof HTTPError) {
    try {
      return extractMessageFromErrorText(await error.response.text())
    } catch {
      return error.message
    }
  }

  return error instanceof Error ? error.message : undefined
}

function extractMessageFromErrorText(errorText: string): string {
  try {
    const parsed = JSON.parse(errorText) as unknown
    const extracted = extractMessageFromParsedError(parsed)
    if (extracted) return extracted
  } catch {
    return errorText
  }

  return errorText
}

function extractMessageFromParsedError(parsed: unknown): string | undefined {
  if (typeof parsed === "string") return parsed
  if (typeof parsed !== "object" || parsed === null) return undefined

  const obj = parsed as Record<string, unknown>
  const error = obj.error
  if (typeof error === "string") return error
  if (typeof error === "object" && error !== null) {
    const nested = error as Record<string, unknown>
    if (typeof nested.message === "string") return nested.message
  }
  if (typeof obj.message === "string") return obj.message

  return undefined
}

async function closeOpenContentBlock(
  stream: SSEStream,
  streamState: AnthropicStreamState,
) {
  if (!streamState.contentBlockOpen) return

  await stream.writeSSE({
    event: "content_block_stop",
    data: JSON.stringify({
      type: "content_block_stop",
      index: streamState.contentBlockIndex,
    }),
  })
}

async function closeStartedMessage(
  stream: SSEStream,
  streamState: AnthropicStreamState,
) {
  if (!streamState.messageStartSent) return

  await stream.writeSSE({
    event: "message_delta",
    data: JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 0 },
    }),
  })
  await stream.writeSSE({
    event: "message_stop",
    data: JSON.stringify({ type: "message_stop" }),
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
