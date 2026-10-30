import { describe, expect, test } from "bun:test"

import type { AnthropicStreamState } from "~/routes/messages/anthropic-types"
import type { ChatCompletionChunk } from "~/services/copilot/create-chat-completions"

import {
  finishAnthropicStream,
  translateChunkToAnthropicEvents,
} from "~/routes/messages/stream-translation"

function chunk(options: {
  content?: string
  finish?: ChatCompletionChunk["choices"][number]["finish_reason"]
  usage?: ChatCompletionChunk["usage"]
  emptyChoices?: boolean
}): ChatCompletionChunk {
  return {
    id: "chatcmpl_usage",
    object: "chat.completion.chunk",
    created: 0,
    model: "gpt-4.1",
    choices:
      options.emptyChoices ?
        []
      : [
          {
            index: 0,
            delta: { content: options.content },
            finish_reason: options.finish ?? null,
            logprobs: null,
          },
        ],
    ...(options.usage ? { usage: options.usage } : {}),
  }
}

function state(): AnthropicStreamState {
  return {
    completion: { kind: "streaming" },
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    toolCalls: {},
  }
}

describe("Messages stream final usage", () => {
  test("usage in an empty-choice tail appears before the single terminal event", () => {
    const stream = state()
    const events = [
      chunk({ content: "Hello" }),
      chunk({ finish: "stop" }),
      chunk({
        emptyChoices: true,
        usage: {
          prompt_tokens: 37,
          completion_tokens: 9,
          total_tokens: 46,
          prompt_tokens_details: { cached_tokens: 5 },
        },
      }),
    ].flatMap((value) => translateChunkToAnthropicEvents(value, stream))
    const delta = events.find((event) => event.type === "message_delta")
    expect(delta).toMatchObject({
      delta: { stop_reason: "end_turn" },
      usage: { input_tokens: 32, output_tokens: 9, cache_read_input_tokens: 5 },
    })
    expect(
      events.filter((event) => event.type === "message_stop"),
    ).toHaveLength(1)
    expect(events.at(-1)?.type).toBe("message_stop")
  })

  test("EOF without a usage tail still emits one terminal event after content", () => {
    const stream = state()
    const content = translateChunkToAnthropicEvents(
      chunk({ content: "Hello" }),
      stream,
    )
    expect(content.some((event) => event.type === "content_block_delta")).toBe(
      true,
    )
    const finishing = translateChunkToAnthropicEvents(
      chunk({ finish: "stop" }),
      stream,
    )
    expect(finishing.map((event) => event.type)).toEqual(["content_block_stop"])
    const terminal = finishAnthropicStream(stream)
    expect(terminal.map((event) => event.type)).toEqual([
      "message_delta",
      "message_stop",
    ])
    expect(finishAnthropicStream(stream)).toEqual([])
  })

  test("valid zero usage is retained and late or duplicate usage cannot add a second stop", () => {
    const stream = state()
    translateChunkToAnthropicEvents(chunk({ content: "Hello" }), stream)
    const events = translateChunkToAnthropicEvents(
      chunk({
        finish: "stop",
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      }),
      stream,
    )
    expect(
      events.find((event) => event.type === "message_delta"),
    ).toHaveProperty("usage", { input_tokens: 0, output_tokens: 0 })
    expect(finishAnthropicStream(stream)).toEqual([])
    expect(
      translateChunkToAnthropicEvents(
        chunk({
          emptyChoices: true,
          usage: {
            prompt_tokens: 37,
            completion_tokens: 9,
            total_tokens: 46,
          },
        }),
        stream,
      ),
    ).toEqual([])
  })

  test("EOF before a finish reason is an interrupted stream", () => {
    const stream = state()
    translateChunkToAnthropicEvents(chunk({ content: "Hello" }), stream)
    expect(() => finishAnthropicStream(stream)).toThrow("finish reason")
  })
})
