import {
  chunkSchema,
  GeminiError,
  type Part,
  type UpstreamChunk,
} from "./schemas"
import { finishReason, functionPart, usageMetadata } from "./translation"

type FunctionBuffer = { id: string; name: string; arguments: string }
export class GeminiStream {
  private readonly calls = new Map<number, FunctionBuffer>()
  private signature: string | undefined
  private finish: string | undefined
  private usage: UpstreamChunk["usage"]
  private responseId: string | undefined
  private modelVersion: string | undefined
  private readonly includeThoughts: boolean
  constructor(includeThoughts: boolean) {
    this.includeThoughts = includeThoughts
  }

  push(data: string): Array<object> {
    let raw: unknown
    try {
      raw = JSON.parse(data)
    } catch {
      throw new GeminiError("Invalid upstream stream event", 502)
    }
    const parsed = chunkSchema.safeParse(raw)
    if (!parsed.success)
      throw new GeminiError("Invalid upstream stream event", 502)
    const chunk = parsed.data
    this.responseId = chunk.id ?? this.responseId
    this.modelVersion = chunk.model ?? this.modelVersion
    this.usage = chunk.usage ?? this.usage
    const output: Array<object> = []
    for (const choice of chunk.choices) {
      const delta = choice.delta
      if (
        delta.reasoning_opaque !== undefined
        && delta.reasoning_opaque !== null
      )
        this.signature = (this.signature ?? "") + delta.reasoning_opaque
      if (this.includeThoughts && delta.reasoning_text)
        output.push(
          this.event(
            [{ text: delta.reasoning_text, thought: true }],
            choice.index,
          ),
        )
      if (delta.content)
        output.push(this.event([{ text: delta.content }], choice.index))
      for (const tool of delta.tool_calls ?? []) this.appendCall(tool)
      this.finish = finishReason(choice.finish_reason) ?? this.finish
    }
    return output
  }
  complete(): Array<object> {
    if (!this.finish)
      throw new GeminiError(
        "Upstream stream ended without a finish reason",
        502,
      )
    const parts: Array<Part> = [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call], index) => {
        if (!call.id || !call.name)
          throw new GeminiError("Upstream function call is incomplete", 502)
        return functionPart(call, index === 0 ? this.signature : undefined)
      })
    if (parts.length === 0 && this.signature !== undefined)
      parts.push({ text: "", thoughtSignature: this.signature })
    return [
      {
        ...this.event(parts, 0),
        usageMetadata: usageMetadata(this.usage),
        candidates: [
          {
            index: 0,
            content: { role: "model", parts },
            finishReason: this.finish,
          },
        ],
      },
    ]
  }
  private appendCall(
    tool: NonNullable<
      UpstreamChunk["choices"][number]["delta"]["tool_calls"]
    >[number],
  ) {
    const call = this.calls.get(tool.index) ?? {
      id: "",
      name: "",
      arguments: "",
    }
    if (tool.id) {
      if (call.id && call.id !== tool.id)
        throw new GeminiError("Upstream changed a function call ID", 502)
      call.id = tool.id
    }
    call.name += tool.function?.name ?? ""
    call.arguments += tool.function?.arguments ?? ""
    this.calls.set(tool.index, call)
  }
  private event(parts: Array<Part>, index: number) {
    return {
      candidates: [{ index, content: { role: "model", parts } }],
      responseId: this.responseId,
      modelVersion: this.modelVersion,
    }
  }
}
