import { afterEach, describe, expect, mock, test } from "bun:test"

import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { getCopilotTokenWithRetry, logUser } from "~/lib/token"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  mock.restore()
  state.githubToken = undefined
})

describe("logUser", () => {
  test("does not fail when the GitHub user lookup is unavailable", async () => {
    state.githubToken = "saved-token"
    const fetchMock = mock(() =>
      Response.json({ message: "Service Unavailable" }, { status: 503 }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await logUser()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe("getCopilotTokenWithRetry", () => {
  test("retries a transient GitHub response", async () => {
    state.githubToken = "saved-token"
    const fetchMock = mock(() => {
      if (fetchMock.mock.calls.length === 1) {
        return Response.json(
          { message: "Service Unavailable" },
          { status: 503 },
        )
      }
      return Response.json({ token: "copilot-token", refresh_in: 1800 })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await getCopilotTokenWithRetry(3, 0)

    expect(response.token).toBe("copilot-token")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test("does not retry an authentication failure", async () => {
    state.githubToken = "invalid-token"
    const fetchMock = mock(() => new Response("Unauthorized", { status: 401 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    try {
      await getCopilotTokenWithRetry(3, 0)
      throw new Error("Expected token request to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(HTTPError)
      if (error instanceof HTTPError) expect(error.response.status).toBe(401)
    }

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
