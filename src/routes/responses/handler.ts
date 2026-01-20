import type { Context } from "hono"
import type { SSEStreamingApi } from "hono/streaming"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

import type { ResponsesApiRequest, ResponsesStreamEvent } from "./types"

import {
  translateChatToResponses,
  translateResponsesToChat,
} from "./translation"

const isNonStreamingResponse = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => "choices" in response

export async function handleResponses(c: Context): Promise<Response> {
  await checkRateLimit(state)

  const request = await c.req.json<ResponsesApiRequest>()
  consola.debug("Responses API request:", JSON.stringify(request).slice(-400))

  if (state.manualApprove) await awaitApproval()

  // Translate Responses API request to Chat Completions format
  const chatPayload = translateResponsesToChat(request)
  consola.debug(
    "Translated to Chat payload:",
    JSON.stringify(chatPayload).slice(-400),
  )

  const response = await createChatCompletions(chatPayload)

  if (isNonStreamingResponse(response)) {
    consola.debug("Non-streaming response:", JSON.stringify(response))
    const responsesResponse = translateChatToResponses(response, request.model)
    return c.json(responsesResponse)
  }

  consola.debug("Streaming response")
  return streamSSE(c, async (stream) => {
    const streamState = createStreamState(request.model)

    await sendCreatedEvent(stream, streamState)

    for await (const rawEvent of response) {
      await processStreamChunk(rawEvent, stream, streamState)
    }

    await sendDoneEvent(stream, streamState)
  })
}

interface StreamState {
  outputText: string
  responseId: string
  model: string
  outputIndex: number
}

function createStreamState(model: string): StreamState {
  return {
    outputText: "",
    responseId: `resp_${Date.now()}`,
    model,
    outputIndex: 0,
  }
}

async function sendCreatedEvent(
  stream: SSEStreamingApi,
  state: StreamState,
): Promise<void> {
  const createdEvent: ResponsesStreamEvent = {
    type: "response.created",
    response: {
      id: state.responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      model: state.model,
      output: [],
      status: "in_progress",
    },
  }
  await stream.writeSSE({
    event: "response.created",
    data: JSON.stringify(createdEvent),
  })
}

async function processStreamChunk(
  rawEvent: { data?: unknown },
  stream: SSEStreamingApi,
  state: StreamState,
): Promise<void> {
  try {
    const chunk = JSON.parse(rawEvent.data as string) as ChatCompletionChunk

    if (chunk.id) {
      state.responseId = chunk.id
    }

    for (const choice of chunk.choices) {
      await processChoice(choice, stream, state)
    }
  } catch {
    // Skip malformed chunks
    consola.debug("Skipping malformed chunk:", rawEvent)
  }
}

async function processChoice(
  choice: ChatCompletionChunk["choices"][0],
  stream: SSEStreamingApi,
  state: StreamState,
): Promise<void> {
  const delta = choice.delta

  if (delta.content) {
    state.outputText += delta.content
    await sendTextDeltaEvent(stream, delta.content, state.outputIndex)
  }

  if (delta.tool_calls) {
    await processToolCalls(delta.tool_calls, stream, state.outputIndex)
  }

  if (choice.finish_reason && state.outputText) {
    await sendTextDoneEvent(stream, state.outputIndex)
  }
}

async function sendTextDeltaEvent(
  stream: SSEStreamingApi,
  content: string,
  outputIndex: number,
): Promise<void> {
  const deltaEvent: ResponsesStreamEvent = {
    type: "response.output_text.delta",
    delta: content,
    output_index: outputIndex,
    content_index: 0,
  }
  await stream.writeSSE({
    event: "response.output_text.delta",
    data: JSON.stringify(deltaEvent),
  })
}

async function processToolCalls(
  toolCalls: NonNullable<
    ChatCompletionChunk["choices"][0]["delta"]
  >["tool_calls"],
  stream: SSEStreamingApi,
  outputIndex: number,
): Promise<void> {
  if (!toolCalls) return

  for (const toolCall of toolCalls) {
    if (toolCall.function?.name) {
      await sendFunctionCallStartEvent(stream, toolCall, outputIndex)
    }

    if (toolCall.function?.arguments) {
      await sendFunctionCallDeltaEvent(
        stream,
        toolCall.function.arguments,
        outputIndex,
      )
    }
  }
}

async function sendFunctionCallStartEvent(
  stream: SSEStreamingApi,
  toolCall: { id?: string; function?: { name?: string } },
  outputIndex: number,
): Promise<void> {
  const funcStartEvent: ResponsesStreamEvent = {
    type: "response.function_call_arguments.start",
    item: {
      id: `fc_${toolCall.id}`,
      type: "function_call",
      name: toolCall.function?.name,
      call_id: toolCall.id,
      status: "in_progress",
    },
    output_index: outputIndex,
  }
  await stream.writeSSE({
    event: "response.function_call_arguments.start",
    data: JSON.stringify(funcStartEvent),
  })
}

async function sendFunctionCallDeltaEvent(
  stream: SSEStreamingApi,
  args: string,
  outputIndex: number,
): Promise<void> {
  const argsDeltaEvent: ResponsesStreamEvent = {
    type: "response.function_call_arguments.delta",
    delta: args,
    output_index: outputIndex,
  }
  await stream.writeSSE({
    event: "response.function_call_arguments.delta",
    data: JSON.stringify(argsDeltaEvent),
  })
}

async function sendTextDoneEvent(
  stream: SSEStreamingApi,
  outputIndex: number,
): Promise<void> {
  const textDoneEvent: ResponsesStreamEvent = {
    type: "response.output_text.done",
    output_index: outputIndex,
    content_index: 0,
  }
  await stream.writeSSE({
    event: "response.output_text.done",
    data: JSON.stringify(textDoneEvent),
  })
}

async function sendDoneEvent(
  stream: SSEStreamingApi,
  state: StreamState,
): Promise<void> {
  const doneEvent: ResponsesStreamEvent = {
    type: "response.done",
    response: {
      id: state.responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      model: state.model,
      output_text: state.outputText,
      status: "completed",
    },
  }
  await stream.writeSSE({
    event: "response.done",
    data: JSON.stringify(doneEvent),
  })
}
