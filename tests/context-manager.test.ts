import { describe, expect, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import {
  fitContext,
  fitUnknownModelContext,
  prepareChatCompletionsWireRequest,
  TOOL_IMAGE_HEADER,
  UNKNOWN_MODEL_PAYLOAD_BYTES,
} from "~/lib/context-manager"
import {
  type ChatCompletionsPayload,
  type ContentPart,
  type Message,
} from "~/services/copilot/create-chat-completions"

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

describe("context manager edge cases", () => {
  test("truncates >100 KB JSON-object and plain-text tool outputs with multibyte UTF-8 and quotes within cap", () => {
    const chunk = '漢"\\😀\n'
    const jsonToolPayload: ChatCompletionsPayload = {
      model: "ultracode",
      max_tokens: 100,
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-json",
              type: "function",
              function: { name: "dump", arguments: "{}" },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call-json",
          content: JSON.stringify({ data: chunk.repeat(300_000) }),
        },
        { role: "user", content: "summarize" },
      ],
    }

    const fittedJson = fitUnknownModelContext(jsonToolPayload)
    const jsonToolMsg = fittedJson.messages.find((msg) => msg.role === "tool")
    expect(typeof jsonToolMsg?.content).toBe("string")
    const jsonContent = jsonToolMsg?.content as string
    expect(Buffer.byteLength(jsonContent, "utf8")).toBeLessThanOrEqual(100_000)
    const parsed = JSON.parse(jsonContent) as {
      truncated?: boolean
      output?: string
    }
    expect(parsed.truncated).toBe(true)
    expect(parsed.output).toContain("tool output truncated")

    const textToolPayload: ChatCompletionsPayload = {
      model: "ultracode",
      max_tokens: 100,
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-text",
              type: "function",
              function: { name: "dump", arguments: "{}" },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call-text",
          content: chunk.repeat(300_000),
        },
        { role: "user", content: "summarize" },
      ],
    }

    const fittedText = fitUnknownModelContext(textToolPayload)
    const textToolMsg = fittedText.messages.find((msg) => msg.role === "tool")
    expect(typeof textToolMsg?.content).toBe("string")
    const textContent = textToolMsg?.content as string
    expect(Buffer.byteLength(textContent, "utf8")).toBeLessThanOrEqual(100_000)
    expect(textContent).toContain("tool output truncated")
  })

  test("preserves non-text/non-image OpenAI content parts without crashing when stripping images or estimating dual policy", () => {
    const audioPart = {
      type: "input_audio",
      input_audio: { data: "AAAA", format: "wav" },
    } as unknown as ContentPart
    const filePart = {
      type: "file",
      file: {
        filename: "notes.pdf",
        file_data: "data:application/pdf;base64,JVBERi0=",
      },
    } as unknown as ContentPart

    const payload: ChatCompletionsPayload = {
      model: "gpt-test",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "analyze attachments" },
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${"A".repeat(1_500_000)}`,
              },
            },
            audioPart,
            filePart,
          ],
        },
        { role: "user", content: "x".repeat(4_000_000) },
      ],
    }

    const prepared = prepareChatCompletionsWireRequest(payload)
    expect(prepared.utf8Bytes).toBeLessThanOrEqual(5_000_000)
    expect(prepared.enableVision).toBe(false)
    expect(Array.isArray(prepared.payload.messages[0]?.content)).toBe(true)
    const parts = prepared.payload.messages[0]?.content as Array<unknown>
    expect(parts).toContainEqual(audioPart)
    expect(parts).toContainEqual(filePart)

    const dualModel: Model = {
      id: "claude-sonnet-4",
      name: "Claude Sonnet 4",
      vendor: "Anthropic",
      object: "model",
      version: "1",
      preview: false,
      model_picker_enabled: true,
      supported_endpoints: ["/chat/completions"],
      capabilities: {
        family: "claude-sonnet-4",
        type: "chat",
        object: "model_capabilities",
        tokenizer: "o200k_base",
        limits: { max_prompt_tokens: 200_000, max_output_tokens: 8_192 },
        supports: { vision: true, streaming: true, tool_calls: true },
      },
    }
    expect(() => fitContext(payload, dualModel)).not.toThrow()
  })

  test("does not delete real user messages starting with TOOL_IMAGE_HEADER without images or placeholders", () => {
    const bareHeader = TOOL_IMAGE_HEADER
    const userQuestion = `${TOOL_IMAGE_HEADER}\n\nWhy does the proxy emit this header?`
    const payload: ChatCompletionsPayload = {
      model: "ultracode",
      max_tokens: 100,
      messages: [
        { role: "user", content: "old-turn " + "x".repeat(2_000_000) },
        { role: "user", content: bareHeader },
        { role: "user", content: userQuestion },
        {
          role: "user",
          content: [{ type: "text", text: TOOL_IMAGE_HEADER }],
        },
        { role: "user", content: "latest question" },
      ],
    }

    const fitted = fitUnknownModelContext(payload)
    expect(
      Buffer.byteLength(JSON.stringify(fitted), "utf8"),
    ).toBeLessThanOrEqual(UNKNOWN_MODEL_PAYLOAD_BYTES)
    expect(fitted.messages.map((msg) => msg.content)).toEqual([
      bareHeader,
      userQuestion,
      [{ type: "text", text: TOOL_IMAGE_HEADER }],
      "latest question",
    ])
  })
})
