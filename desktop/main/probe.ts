import { z } from "zod"

import type { NativeConnection } from "../../src/lib/proxy-contracts"
import type { DesktopModel, DesktopSnapshot } from "../shared/contracts"

import { isGoogleChatModel } from "../../src/lib/proxy-contracts"
import { connectionOrigin } from "../shared/connections"

const probeReplySchema = z.object({
  output_text: z.string().nullish(),
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullish() }).nullish(),
      }),
    )
    .nullish(),
  output: z
    .array(
      z.object({
        content: z.array(z.object({ text: z.string().nullish() })).nullish(),
      }),
    )
    .nullish(),
})

const geminiProbeReplySchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({
            parts: z
              .array(
                z.object({
                  text: z.string().nullish(),
                  thought: z.boolean().nullish(),
                }),
              )
              .nullish(),
          })
          .nullish(),
      }),
    )
    .nullish(),
})

function extractProbeText(raw: unknown): string {
  const reply = probeReplySchema.parse(raw)
  const outputText =
    reply.output
      ?.flatMap(
        (output) => output.content?.map((part) => part.text ?? "") ?? [],
      )
      .join("") ?? ""
  const text =
    reply.output_text || reply.choices?.[0]?.message?.content || outputText
  if (!text) throw new Error("empty-response")
  return text.slice(0, 16_000)
}

function extractGeminiProbeText(raw: unknown): string {
  const reply = geminiProbeReplySchema.parse(raw)
  const parts = reply.candidates?.[0]?.content?.parts ?? []
  const text = parts
    .filter(
      (part): part is { text: string; thought?: boolean | null } =>
        part.thought !== true && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("")
    .trim()
  if (!text) throw new Error("empty-response")
  return text.slice(0, 16_000)
}

function probeRequest(options: {
  connection: NativeConnection
  model: DesktopModel
  prompt: string
}): {
  url: string
  headers: Record<string, string>
  body: string
  gemini: boolean
} {
  const { connection, model, prompt } = options
  if (isGoogleChatModel(model)) {
    return {
      url: `${connectionOrigin(connection)}/v1beta/models/${encodeURIComponent(model.id)}:generateContent`,
      headers: {
        ...(connection.authentication.kind === "keyed" ?
          { "x-goog-api-key": connection.authentication.key }
        : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 128 },
      }),
      gemini: true,
    }
  }
  const usesChat = model.endpoints.includes("/chat/completions")
  if (!usesChat && !model.endpoints.includes("/responses"))
    throw new Error("unsupported")
  return {
    url: `${connection.apiUrl.replace(/\/$/, "")}/${usesChat ? "chat/completions" : "responses"}`,
    headers: {
      ...(connection.authentication.kind === "keyed" ?
        { authorization: `Bearer ${connection.authentication.key}` }
      : {}),
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
    gemini: false,
  }
}

export async function executeProbe(options: {
  connection: NativeConnection
  model: DesktopModel
  prompt: string
  signal: AbortSignal
}): Promise<Extract<DesktopSnapshot["probe"], { kind: "complete" }>> {
  const { model } = options
  const started = performance.now()
  const request = probeRequest(options)
  const response = await fetch(request.url, {
    method: "POST",
    redirect: "error",
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error("request-failed")
  }
  const raw = await response.text()
  if (raw.length > 200_000) throw new Error("large-response")
  const parsed: unknown = JSON.parse(raw)
  return {
    kind: "complete",
    model: model.id,
    text:
      request.gemini ?
        extractGeminiProbeText(parsed)
      : extractProbeText(parsed),
    durationMs: performance.now() - started,
  }
}
