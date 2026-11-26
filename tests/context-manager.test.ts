import { describe, expect, test } from "bun:test"

import {
  fitUnknownModelContext,
  UNKNOWN_MODEL_PAYLOAD_BYTES,
} from "~/lib/context-manager"
import {
  type ChatCompletionsPayload,
  type Message,
} from "~/services/copilot/create-chat-completions"

const TOOL_IMAGE_HEADER =
  "Attached image(s) returned by the preceding tool call(s):"

function assertNoOrphanedToolMessages(messages: Array<Message>) {
  const seenToolCallIds = new Set<string>()
  let lastRoleWasTool = false

  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const tc of msg.tool_calls ?? []) {
        seenToolCallIds.add(tc.id)
      }
      lastRoleWasTool = false
      continue
    }

    if (msg.role === "tool") {
      expect(msg.tool_call_id).toBeDefined()
      expect(seenToolCallIds.has(msg.tool_call_id ?? "")).toBe(true)
      lastRoleWasTool = true
      continue
    }

    if (msg.role === "user") {
      const text =
        typeof msg.content === "string" ?
          msg.content
        : (msg.content ?? [])
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("\n")
      if (text.includes(TOOL_IMAGE_HEADER)) {
        expect(lastRoleWasTool).toBe(true)
      }
      lastRoleWasTool = false
      continue
    }

    lastRoleWasTool = false
  }
}

describe("context manager", () => {
  test("conservatively fits unknown custom model aliases", () => {
    const payload: ChatCompletionsPayload = {
      model: "ultracode",
      max_tokens: 100,
      messages: [
        { role: "user", content: "old-1\n" + "x".repeat(900_000) },
        { role: "assistant", content: "old-2\n" + "x".repeat(900_000) },
        { role: "user", content: "old-3\n" + "x".repeat(900_000) },
        { role: "assistant", content: "old-4\n" + "x".repeat(900_000) },
        { role: "user", content: "latest task" },
      ],
    }

    const fitted = fitUnknownModelContext(payload)

    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(
      UNKNOWN_MODEL_PAYLOAD_BYTES,
    )
    expect(fitted.messages.at(-1)?.content).toBe("latest task")
    expect(fitted.messages.length).toBeLessThan(payload.messages.length)
  })

  test("atomic turn-group dropping never strands orphaned tool outputs or Gemini synthetic tool-image user messages", () => {
    const makeToolRound = (options: {
      id: string
      assistantFill: string
      toolDetailLength: number
      imageTag: string
    }): Array<Message> => [
      {
        role: "assistant",
        content: options.assistantFill,
        tool_calls: [
          {
            id: options.id,
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: `${options.id}.png` }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: options.id,
        content: JSON.stringify({
          ok: true,
          id: options.id,
          detail: "t".repeat(options.toolDetailLength),
        }),
      },
      {
        role: "user",
        content: [
          { type: "text", text: TOOL_IMAGE_HEADER },
          {
            type: "image_url",
            image_url: {
              url: `data:image/png;base64,${options.imageTag.repeat(20_000)}`,
            },
          },
        ],
      },
    ]

    const dropPayload: ChatCompletionsPayload = {
      model: "ultracode",
      max_tokens: 100,
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "turn-0 " + "a".repeat(300_000) },
        ...makeToolRound({
          id: "call-1",
          assistantFill: "a1 " + "b".repeat(650_000),
          toolDetailLength: 100,
          imageTag: "A",
        }),
        ...makeToolRound({
          id: "call-2",
          assistantFill: "a2 " + "c".repeat(700_000),
          toolDetailLength: 100,
          imageTag: "B",
        }),
        ...makeToolRound({
          id: "call-3",
          assistantFill: "a3 " + "d".repeat(700_000),
          toolDetailLength: 100,
          imageTag: "C",
        }),
        { role: "user", content: "final active " + "漢".repeat(180_000) },
      ],
    }

    const fittedDrop = fitUnknownModelContext(dropPayload)
    assertNoOrphanedToolMessages(fittedDrop.messages)
    expect(
      Buffer.byteLength(JSON.stringify(fittedDrop), "utf8"),
    ).toBeLessThanOrEqual(UNKNOWN_MODEL_PAYLOAD_BYTES)
    expect(fittedDrop.messages.at(-1)?.content).toBe(
      dropPayload.messages.at(-1)?.content,
    )

    const tailOrphanPayload: ChatCompletionsPayload = {
      model: "ultracode",
      max_tokens: 100,
      messages: [
        ...makeToolRound({
          id: "call-big",
          assistantFill: "oversized " + "z".repeat(2_100_000),
          toolDetailLength: 100,
          imageTag: "Z",
        }).slice(0, 2),
        { role: "user", content: "latest active prompt" },
      ],
    }

    const fittedTail = fitUnknownModelContext(tailOrphanPayload)
    assertNoOrphanedToolMessages(fittedTail.messages)
    expect(
      Buffer.byteLength(JSON.stringify(fittedTail), "utf8"),
    ).toBeLessThanOrEqual(UNKNOWN_MODEL_PAYLOAD_BYTES)
    expect(fittedTail.messages.at(-1)?.content).toBe("latest active prompt")

    const prunePayload: ChatCompletionsPayload = {
      model: "ultracode",
      max_tokens: 100,
      messages: [
        ...makeToolRound({
          id: "call-old",
          assistantFill: "old",
          toolDetailLength: 900_000,
          imageTag: "O",
        }).slice(0, 2),
        ...makeToolRound({
          id: "call-mid",
          assistantFill: "mid",
          toolDetailLength: 900_000,
          imageTag: "M",
        }).slice(0, 2),
        ...makeToolRound({
          id: "call-recent",
          assistantFill: "recent",
          toolDetailLength: 250_000,
          imageTag: "R",
        }).slice(0, 2),
        { role: "user", content: "summarize tool results" },
      ],
    }

    const fittedPruned = fitUnknownModelContext(prunePayload)
    assertNoOrphanedToolMessages(fittedPruned.messages)
    expect(
      Buffer.byteLength(JSON.stringify(fittedPruned), "utf8"),
    ).toBeLessThanOrEqual(UNKNOWN_MODEL_PAYLOAD_BYTES)
    const survivingTools = fittedPruned.messages.filter(
      (msg) => msg.role === "tool",
    )
    expect(survivingTools).toHaveLength(3)
    const prunedOldTool = survivingTools.find(
      (msg) => msg.tool_call_id === "call-old",
    )
    expect(typeof prunedOldTool?.content).toBe("string")
    expect((prunedOldTool?.content as string).length).toBeLessThan(100_000)
    for (const toolMsg of survivingTools) {
      expect(typeof toolMsg.content).toBe("string")
      expect(() => {
        JSON.parse(toolMsg.content as string)
      }).not.toThrow()
    }
  })
})
