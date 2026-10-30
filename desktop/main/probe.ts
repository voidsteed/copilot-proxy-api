import { z } from "zod"

import type { DesktopModel, DesktopSnapshot } from "../shared/contracts"

const probeReplySchema = z.object({
  output_text: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z
          .object({ content: z.string().nullable().optional() })
          .optional(),
      }),
    )
    .optional(),
  output: z
    .array(
      z.object({
        content: z.array(z.object({ text: z.string().optional() })).optional(),
      }),
    )
    .optional(),
})

function extractProbeText(raw: unknown): string {
  const reply = probeReplySchema.parse(raw)
  const text =
    reply.output_text
    ?? reply.choices?.[0]?.message?.content
    ?? reply.output
      ?.flatMap(
        (output) => output.content?.map((part) => part.text ?? "") ?? [],
      )
      .join("")
    ?? ""
  if (!text) throw new Error("empty-response")
  return text.slice(0, 16_000)
}

export async function executeProbe(options: {
  baseUrl: string
  gatewayKey: string
  model: DesktopModel
  prompt: string
  signal: AbortSignal
}): Promise<Extract<DesktopSnapshot["probe"], { kind: "complete" }>> {
  const { model, prompt } = options
  const started = performance.now()
  const usesChat = model.endpoints.includes("/chat/completions")
  if (!usesChat && !model.endpoints.includes("/responses"))
    throw new Error("unsupported")
  const response = await fetch(
    `${options.baseUrl}/${usesChat ? "chat/completions" : "responses"}`,
    {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${options.gatewayKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(
        usesChat ?
          {
            model: model.id,
            messages: [{ role: "user", content: prompt }],
            stream: false,
            max_tokens: 128,
          }
        : {
            model: model.id,
            input: prompt,
            stream: false,
            max_output_tokens: 128,
          },
      ),
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]),
    },
  )
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error("request-failed")
  }
  const raw = await response.text()
  if (raw.length > 200_000) throw new Error("large-response")
  return {
    kind: "complete",
    model: model.id,
    text: extractProbeText(JSON.parse(raw) as unknown),
    durationMs: performance.now() - started,
  }
}
