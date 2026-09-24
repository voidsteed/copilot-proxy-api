import { type ChatCompletionChunk } from "~/services/copilot/create-chat-completions"

import {
  type AnthropicStreamEventData,
  type AnthropicStreamState,
} from "./anthropic-types"
import { mapOpenAIStopReasonToAnthropic } from "./utils"

function isToolBlockOpen(state: AnthropicStreamState): boolean {
  if (!state.contentBlockOpen) {
    return false
  }
  // Check if the current block index corresponds to any known tool call
  return Object.values(state.toolCalls).some(
    (tc) => tc.anthropicBlockIndex === state.contentBlockIndex,
  )
}

function closeOpenBlock(
  state: AnthropicStreamState,
  events: Array<AnthropicStreamEventData>,
): void {
  if (!state.contentBlockOpen) return
  events.push({ type: "content_block_stop", index: state.contentBlockIndex })
  state.contentBlockIndex++
  state.contentBlockOpen = false
  state.thinkingBlockOpen = false
}

function openThinkingBlock(
  state: AnthropicStreamState,
  events: Array<AnthropicStreamEventData>,
): void {
  if (state.thinkingBlockOpen) return
  closeOpenBlock(state, events)
  events.push({
    type: "content_block_start",
    index: state.contentBlockIndex,
    content_block: { type: "thinking", thinking: "" },
  })
  state.contentBlockOpen = true
  state.thinkingBlockOpen = true
}

/**
 * Copilot streams Claude's reasoning as `reasoning_text` deltas, then a single
 * `reasoning_opaque` signature. Forward them as an Anthropic thinking block:
 * on long high-effort turns this is the only output for minutes, and without
 * it Claude Code sees a silent stream (pings don't count as progress).
 */
function translateReasoningDelta(
  delta: ChatCompletionChunk["choices"][number]["delta"],
  state: AnthropicStreamState,
  events: Array<AnthropicStreamEventData>,
): void {
  if (delta.reasoning_text) {
    openThinkingBlock(state, events)
    events.push({
      type: "content_block_delta",
      index: state.contentBlockIndex,
      delta: { type: "thinking_delta", thinking: delta.reasoning_text },
    })
  }

  if (delta.reasoning_opaque) {
    openThinkingBlock(state, events)
    events.push({
      type: "content_block_delta",
      index: state.contentBlockIndex,
      delta: { type: "signature_delta", signature: delta.reasoning_opaque },
    })
  }
}

// eslint-disable-next-line max-lines-per-function, complexity
export function translateChunkToAnthropicEvents(
  chunk: ChatCompletionChunk,
  state: AnthropicStreamState,
): Array<AnthropicStreamEventData> {
  const events: Array<AnthropicStreamEventData> = []

  if (chunk.choices.length === 0) {
    return events
  }

  const choice = chunk.choices[0]
  const { delta } = choice

  if (!state.messageStartSent) {
    events.push({
      type: "message_start",
      message: {
        id: chunk.id,
        type: "message",
        role: "assistant",
        content: [],
        model: chunk.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens:
            (chunk.usage?.prompt_tokens ?? 0)
            - (chunk.usage?.prompt_tokens_details?.cached_tokens ?? 0),
          output_tokens: 0, // Will be updated in message_delta when finished
          ...(chunk.usage?.prompt_tokens_details?.cached_tokens
            !== undefined && {
            cache_read_input_tokens:
              chunk.usage.prompt_tokens_details.cached_tokens,
          }),
        },
      },
    })
    state.messageStartSent = true
  }

  translateReasoningDelta(delta, state, events)

  if (delta.content) {
    if (isToolBlockOpen(state) || state.thinkingBlockOpen) {
      // A tool or thinking block was open, so close it before starting text.
      closeOpenBlock(state, events)
    }

    if (!state.contentBlockOpen) {
      events.push({
        type: "content_block_start",
        index: state.contentBlockIndex,
        content_block: {
          type: "text",
          text: "",
        },
      })
      state.contentBlockOpen = true
    }

    events.push({
      type: "content_block_delta",
      index: state.contentBlockIndex,
      delta: {
        type: "text_delta",
        text: delta.content,
      },
    })
  }

  if (delta.tool_calls) {
    for (const toolCall of delta.tool_calls) {
      if (toolCall.id && toolCall.function?.name) {
        // New tool call starting. Close any previously open block.
        closeOpenBlock(state, events)

        const anthropicBlockIndex = state.contentBlockIndex
        state.toolCalls[toolCall.index] = {
          id: toolCall.id,
          name: toolCall.function.name,
          anthropicBlockIndex,
        }

        events.push({
          type: "content_block_start",
          index: anthropicBlockIndex,
          content_block: {
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.function.name,
            input: {},
          },
        })
        state.contentBlockOpen = true
      }

      if (toolCall.function?.arguments) {
        const toolCallInfo = state.toolCalls[toolCall.index]
        // Tool call can still be empty
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (toolCallInfo) {
          events.push({
            type: "content_block_delta",
            index: toolCallInfo.anthropicBlockIndex,
            delta: {
              type: "input_json_delta",
              partial_json: toolCall.function.arguments,
            },
          })
        }
      }
    }
  }

  if (choice.finish_reason) {
    if (state.contentBlockOpen) {
      events.push({
        type: "content_block_stop",
        index: state.contentBlockIndex,
      })
      state.contentBlockOpen = false
      state.thinkingBlockOpen = false
    }

    events.push(
      {
        type: "message_delta",
        delta: {
          stop_reason: mapOpenAIStopReasonToAnthropic(choice.finish_reason),
          stop_sequence: null,
        },
        usage: {
          input_tokens:
            (chunk.usage?.prompt_tokens ?? 0)
            - (chunk.usage?.prompt_tokens_details?.cached_tokens ?? 0),
          output_tokens: chunk.usage?.completion_tokens ?? 0,
          ...(chunk.usage?.prompt_tokens_details?.cached_tokens
            !== undefined && {
            cache_read_input_tokens:
              chunk.usage.prompt_tokens_details.cached_tokens,
          }),
        },
      },
      {
        type: "message_stop",
      },
    )
  }

  return events
}

export function translateErrorToAnthropicErrorEvent(
  message?: string,
): AnthropicStreamEventData {
  if (isContextOverflowMessage(message)) {
    return {
      type: "error",
      error: {
        type: "invalid_request_error",
        message:
          "prompt is too long: upstream operation timed out while streaming the response",
      },
    }
  }

  return {
    type: "error",
    error: {
      type: "api_error",
      message: message ?? "An unexpected error occurred during streaming.",
    },
  }
}

function isContextOverflowMessage(message: string | undefined): boolean {
  return (
    message !== undefined
    && (/prompt is too long/i.test(message)
      || /operation timed out/i.test(message)
      || /request entity too large/i.test(message)
      || /context_length_exceeded/i.test(message)
      || /payload too large/i.test(message)
      || /maximum context length/i.test(message))
  )
}
