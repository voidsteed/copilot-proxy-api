import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { state } from "~/lib/state"
import * as utils from "~/lib/utils"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"
import { createResponses } from "~/services/copilot/create-responses"

const originalFetch = globalThis.fetch
const originalState = { ...state }
const input = "x".repeat(2_000_001)

beforeEach(() => {
  state.copilotToken = "expired-token"
  state.githubToken = "saved-github-token"
  state.accountType = "individual"
  state.models = undefined
  spyOn(utils, "sleep").mockResolvedValue(undefined)
})

afterEach(() => {
  globalThis.fetch = originalFetch
  mock.restore()
  Object.assign(state, originalState)
})

const services = [
  {
    name: "Chat Completions",
    send: () =>
      createChatCompletions({
        model: "test-1m",
        messages: [{ role: "user", content: input }],
        max_tokens: 1,
      }),
  },
  {
    name: "Responses",
    send: () =>
      createResponses({
        model: "test-1m",
        input,
        max_output_tokens: 1,
      }),
  },
]

for (const { name, send } of services) {
  test.each([
    { failure: "timeout", status: 500 },
    { failure: "HTTP 503", status: 503 },
  ])(
    `${name}: token $failure does not trigger context compaction`,
    async ({ failure, status }) => {
      let tokenRequests = 0
      let generationRequests = 0
      let forwardedLargePayload = false
      globalThis.fetch = mock((url: string, init?: RequestInit) => {
        if (url === "https://api.github.com/copilot_internal/v2/token") {
          tokenRequests++
          if (failure === "timeout") {
            throw new DOMException("The operation timed out.", "TimeoutError")
          }
          return Response.json(
            { message: "Temporarily unavailable" },
            { status: 503 },
          )
        }
        if (!url.startsWith("https://api.githubcopilot.com/")) {
          throw new Error(`Unexpected upstream: ${url}`)
        }
        generationRequests++
        forwardedLargePayload =
          typeof init?.body === "string" && init.body.length > 2_000_000
        return new Response("Token expired", { status: 401 })
      }) as unknown as typeof fetch

      const app = new Hono()
      app.get("/", async (c) => {
        try {
          await send()
          return c.json({ success: true })
        } catch (error) {
          return forwardError(c, error)
        }
      })

      const response = await app.request("/")
      const body = (await response.json()) as {
        error: { type: string; message: string }
      }

      expect(forwardedLargePayload).toBe(true)
      expect(response.status).toBe(status)
      expect(body.error.type).toBe("api_error")
      expect(body.error.message).not.toContain("prompt is too long")
      expect(tokenRequests).toBe(3)
      expect(generationRequests).toBe(1)
    },
  )
}
