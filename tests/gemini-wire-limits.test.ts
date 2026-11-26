import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import { state } from "~/lib/state"
import * as utils from "~/lib/utils"
import { server } from "~/server"

const originalFetch = globalThis.fetch
const neonModel: Model = {
  id: "gemini-4-neon",
  name: "Gemini 4 Neon",
  vendor: "Google",
  object: "model",
  version: "1",
  preview: true,
  model_picker_enabled: true,
  supported_endpoints: ["/chat/completions"],
  capabilities: {
    family: "gemini-4-neon",
    type: "chat",
    object: "model_capabilities",
    tokenizer: "o200k_base",
    limits: {
      max_prompt_tokens: 983_040,
      max_output_tokens: 65_536,
      vision: { max_prompt_images: 10, max_prompt_image_size: 3_145_728 },
    },
    supports: {
      vision: true,
      streaming: true,
      tool_calls: true,
      reasoning_effort: ["low", "medium", "high", "xhigh"],
    },
  },
}

const textRequest = { contents: [{ role: "user", parts: [{ text: "hello" }] }] }
let sent: Array<unknown> = []
let sentRaw: Array<string> = []

function generate(body: unknown, modelId = neonModel.id) {
  return server.request(`/v1beta/models/${modelId}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function mockUpstream(res: () => Response) {
  globalThis.fetch = Object.assign(() => Promise.resolve(res()), {
    preconnect: originalFetch.preconnect,
  })
}

function makeSizedPngBase64(tag: number, rawBytes = 984_000): string {
  const bytes = Buffer.alloc(rawBytes, 0x41 + tag)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, tag], 0)
  return bytes.toString("base64")
}

beforeEach(() => {
  sent = []
  sentRaw = []
  state.models = { object: "list", data: [neonModel] }
  state.copilotToken = "fake-upstream"
  state.githubToken = undefined
  state.localApiKeys = []
  state.rateLimitSeconds = undefined
  globalThis.fetch = Object.assign(
    (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.body && typeof init.body === "string") {
        sentRaw.push(init.body)
        sent.push(JSON.parse(init.body))
      }
      return Promise.resolve(
        Response.json({
          id: "reply",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "hello" },
              finish_reason: "stop",
            },
          ],
        }),
      )
    },
    { preconnect: originalFetch.preconnect },
  )
})

afterEach(() => {
  globalThis.fetch = originalFetch
  mock.restore()
  state.models = undefined
  state.githubToken = undefined
  state.localApiKeys = []
  state.rateLimitSeconds = undefined
})

test("enforces Copilot 5 MB UTF-8 wire ceiling by stripping oldest images one-by-one while preserving newest images", async () => {
  const pngs = [0, 1, 2, 3].map((tag) => makeSizedPngBase64(tag))
  const toUrl = (i: number) => `data:image/png;base64,${pngs[i]}`
  const png = (i: number) => ({
    inlineData: { mimeType: "image/png", data: pngs[i] },
  })
  const img = (i: number) => ({
    type: "image_url",
    image_url: { url: toUrl(i) },
  })

  const oversized = await generate({
    contents: [
      { role: "user", parts: [{ text: "batch 1" }, png(0), png(1)] },
      { role: "model", parts: [{ text: "noted" }] },
      { role: "user", parts: [{ text: "batch 2" }, png(2), png(3)] },
    ],
  })
  expect(oversized.status).toBe(200)
  expect(sentRaw).toHaveLength(1)
  expect(Buffer.byteLength(sentRaw[0], "utf8")).toBeLessThanOrEqual(5_000_000)
  expect(sentRaw[0]).not.toContain(pngs[0])

  type Part = { type: string; text?: string; image_url?: { url: string } }
  const payload = sent[0] as {
    messages: Array<{ content: string | Array<Part> }>
  }
  const urls = payload.messages.flatMap((m) =>
    Array.isArray(m.content) ?
      m.content
        .filter((p) => p.type === "image_url")
        .map((p) => p.image_url?.url)
    : [],
  )
  expect(urls).toEqual([toUrl(1), toUrl(2), toUrl(3)])
  expect(Array.isArray(payload.messages[0]?.content)).toBe(true)
  const first = payload.messages[0]?.content as Array<Part>
  expect(first).toHaveLength(3)
  expect(first[0]).toEqual({ type: "text", text: "batch 1" })
  expect(first[1]?.type).toBe("text")
  expect(first[1]?.text?.trim().length).toBeGreaterThan(0)
  expect(first[2]).toEqual(img(1))

  sent = []
  sentRaw = []
  const ok = await generate({
    contents: [{ role: "user", parts: [{ text: "ok" }, png(0), png(1)] }],
  })
  expect(ok.status).toBe(200)
  expect(Buffer.byteLength(sentRaw[0], "utf8")).toBeGreaterThan(2_500_000)
  expect(Buffer.byteLength(sentRaw[0], "utf8")).toBeLessThanOrEqual(5_000_000)
  expect(sent[0]).toMatchObject({
    messages: [
      { role: "user", content: [{ type: "text", text: "ok" }, img(0), img(1)] },
    ],
  })
})

test("surfaces upstream-reported token counts on Gemini overflow and preserves transient 503 outages over 2 MB", async () => {
  type ErrBody = { error: { code: number; status: string; message: string } }
  const overflowErr = {
    code: "model_max_prompt_tokens_exceeded",
    message: "prompt token count of 1050000 exceeds the limit of 983040",
  }
  mockUpstream(() => Response.json({ error: overflowErr }, { status: 400 }))
  const overflow = await generate(textRequest)
  expect(overflow.status).toBe(400)
  const overflowBody = (await overflow.json()) as ErrBody
  expect(overflowBody.error).toMatchObject({
    code: 400,
    status: "INVALID_ARGUMENT",
  })
  expect(overflowBody.error.message).toContain("1050000")
  expect(overflowBody.error.message).toContain("983040")
  expect(overflowBody.error.message).not.toContain("prompt token count of")
  expect(overflowBody.error.message).not.toContain(
    "model_max_prompt_tokens_exceeded",
  )

  spyOn(utils, "sleep").mockResolvedValue(undefined)
  mockUpstream(
    () =>
      new Response("Service Unavailable: upstream connect error", {
        status: 503,
        statusText: "Service Unavailable",
      }),
  )
  const outage = await generate({
    contents: [{ role: "user", parts: [{ text: "a".repeat(2_500_000) }] }],
  })
  expect(outage.status).toBe(503)
  const outageBody = (await outage.json()) as ErrBody
  expect(outageBody.error).toMatchObject({ code: 503, status: "UNAVAILABLE" })
  expect(outageBody.error.message).not.toContain("upstream connect error")
  expect(outageBody.error.message).not.toContain("token count")
})

test("maps exhausted upstream Copilot HTTP 499 to retryable 503 UNAVAILABLE instead of CANCELLED", async () => {
  spyOn(utils, "sleep").mockResolvedValue(undefined)
  mockUpstream(() => new Response("client closed", { status: 499 }))
  const response = await generate(textRequest)
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({
    error: {
      code: 503,
      status: "UNAVAILABLE",
      message: "Upstream request failed",
    },
  })
})
