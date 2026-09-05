import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"

import {
  copilotFetch,
  isLikelyContextOverflowTimeout,
} from "~/lib/copilot-fetch"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import * as utils from "~/lib/utils"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  mock.restore()
  state.copilotToken = undefined
  state.githubToken = undefined
})

describe("copilotFetch", () => {
  test("retries transient upstream responses", async () => {
    const fetchMock = mock(() => {
      if (fetchMock.mock.calls.length === 1) {
        return new Response("busy", { status: 503 })
      }
      return new Response("ok", { status: 200 })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await copilotFetch("https://example.com", {
      method: "POST",
      retryDelayMs: 0,
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test("does not retry likely context-overflow large payload failures", async () => {
    const fetchMock = mock(() => new Response("timed out", { status: 500 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await copilotFetch("https://example.com", {
      method: "POST",
      body: "x".repeat(2_000_001),
      retryDelayMs: 0,
    })

    expect(response.status).toBe(500)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  test("retries transient network failures", async () => {
    const fetchMock = mock(() => {
      if (fetchMock.mock.calls.length === 1) {
        throw new Error("socket closed")
      }
      return new Response("ok", { status: 200 })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await copilotFetch("https://example.com", {
      method: "POST",
      retryDelayMs: 0,
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test("refreshes a rejected Copilot token and retries once", async () => {
    state.copilotToken = "stale-token"
    state.githubToken = "github-token"

    const fetchMock = mock((url: string, init?: RequestInit) => {
      if (url.includes("/copilot_internal/v2/token")) {
        return Response.json({ token: "fresh-token" })
      }

      const authorization = new Headers(init?.headers).get("Authorization")
      if (authorization === "Bearer stale-token") {
        return new Response("forbidden", { status: 403 })
      }
      return new Response("ok", { status: 200 })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await copilotFetch(
      "https://api.githubcopilot.com/responses",
      {
        method: "POST",
        headers: { Authorization: "Bearer stale-token" },
        retryDelayMs: 0,
      },
    )

    expect(response.status).toBe(200)
    expect(state.copilotToken).toBe("fresh-token")
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  test("does not retry likely context-overflow timeout throws", async () => {
    const fetchMock = mock(() => {
      throw new Error("The operation timed out.")
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    try {
      await copilotFetch("https://example.com", {
        method: "POST",
        body: "x".repeat(2_000_001),
        retryDelayMs: 0,
      })
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe("The operation timed out.")
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe("copilotFetch token recovery", () => {
  test("recovers when token renewal temporarily returns 503", async () => {
    state.copilotToken = "stale-token"
    state.githubToken = "github-token"
    spyOn(utils, "sleep").mockResolvedValue(undefined)
    let tokenRequests = 0
    const authorizations: Array<string | null> = []
    globalThis.fetch = mock((url: string, init?: RequestInit) => {
      if (url.includes("/copilot_internal/v2/token")) {
        tokenRequests++
        return tokenRequests === 1 ?
            new Response("unavailable", { status: 503 })
          : Response.json({
              token: "fresh-token",
              refresh_in: 1800,
              expires_at: 2_000_000_000,
            })
      }
      const authorization = new Headers(init?.headers).get("Authorization")
      authorizations.push(authorization)
      return authorization === "Bearer stale-token" ?
          new Response("expired", { status: 401 })
        : new Response("recovered", { status: 200 })
    }) as unknown as typeof fetch

    const response = await copilotFetch(
      "https://api.githubcopilot.com/responses",
      {
        headers: { Authorization: "Bearer stale-token" },
        retryDelayMs: 0,
      },
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("recovered")
    expect(authorizations).toEqual(["Bearer stale-token", "Bearer fresh-token"])
    expect(tokenRequests).toBe(2)
  })

  test("retries a replay network failure using the refreshed token", async () => {
    state.copilotToken = "stale-token"
    state.githubToken = "github-token"
    let tokenRequests = 0
    const authorizations: Array<string | null> = []
    globalThis.fetch = mock((url: string, init?: RequestInit) => {
      if (url.includes("/copilot_internal/v2/token")) {
        tokenRequests++
        return Response.json({
          token: "fresh-token",
          refresh_in: 1800,
          expires_at: 2_000_000_000,
        })
      }
      authorizations.push(new Headers(init?.headers).get("Authorization"))
      if (authorizations.length === 1)
        return new Response("expired", { status: 401 })
      if (authorizations.length === 2)
        throw new Error("socket closed during replay")
      return new Response("recovered", { status: 200 })
    }) as unknown as typeof fetch

    const response = await copilotFetch(
      "https://api.githubcopilot.com/responses",
      {
        headers: { Authorization: "Bearer stale-token" },
        retryDelayMs: 0,
      },
    )

    expect(await response.text()).toBe("recovered")
    expect(authorizations).toEqual([
      "Bearer stale-token",
      "Bearer fresh-token",
      "Bearer fresh-token",
    ])
    expect(tokenRequests).toBe(1)
  })

  test("propagates replay network failures after the request retry budget", async () => {
    state.copilotToken = "stale-token"
    state.githubToken = "github-token"
    let tokenRequests = 0
    let apiRequests = 0
    const replayError = new Error("socket closed during replay")
    globalThis.fetch = mock((url: string) => {
      if (url.includes("/copilot_internal/v2/token")) {
        tokenRequests++
        return Response.json({
          token: "fresh-token",
          refresh_in: 1800,
          expires_at: 2_000_000_000,
        })
      }
      apiRequests++
      if (apiRequests === 1) return new Response("expired", { status: 401 })
      throw replayError
    }) as unknown as typeof fetch

    const error = await copilotFetch(
      "https://api.githubcopilot.com/responses",
      {
        headers: { Authorization: "Bearer stale-token" },
        attempts: 2,
        retryDelayMs: 0,
      },
    ).catch((error: unknown) => error)
    expect(error).toBe(replayError)
    expect(apiRequests).toBe(3)
    expect(tokenRequests).toBe(1)
  })
})

describe("copilotFetch token refresh failures", () => {
  test("gives concurrent callers readable token outage errors after shared retries", async () => {
    state.copilotToken = "stale-token"
    state.githubToken = "github-token"
    spyOn(utils, "sleep").mockResolvedValue(undefined)
    let tokenRequests = 0
    let apiRequests = 0
    globalThis.fetch = mock((url: string) => {
      if (url.includes("/copilot_internal/v2/token")) {
        tokenRequests++
        return new Response(`token outage ${tokenRequests}`, { status: 503 })
      }
      apiRequests++
      return new Response("expired", { status: 401 })
    }) as unknown as typeof fetch

    const results = await Promise.allSettled(
      [1, 2].map(() =>
        copilotFetch("https://api.githubcopilot.com/responses", {
          headers: { Authorization: "Bearer stale-token" },
          retryDelayMs: 0,
        }),
      ),
    )

    expect(results.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ])
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(HTTPError)
        if (result.reason instanceof HTTPError) {
          expect(result.reason.response.status).toBe(503)
          expect(await result.reason.response.text()).toBe("token outage 3")
        }
      }
    }
    expect(tokenRequests).toBe(3)
    expect(apiRequests).toBe(2)
  })

  test("preserves the origin of token timeouts without retrying expired credentials", async () => {
    state.copilotToken = "stale-token"
    state.githubToken = "github-token"
    spyOn(utils, "sleep").mockResolvedValue(undefined)
    let tokenRequests = 0
    let apiRequests = 0
    const tokenError = new DOMException(
      "The operation timed out.",
      "TimeoutError",
    )
    globalThis.fetch = mock((url: string) => {
      if (url.includes("/copilot_internal/v2/token")) {
        tokenRequests++
        throw tokenError
      }
      apiRequests++
      return new Response("expired", { status: 401 })
    }) as unknown as typeof fetch

    const error = await copilotFetch(
      "https://api.githubcopilot.com/responses",
      {
        headers: { Authorization: "Bearer stale-token" },
        body: "x".repeat(2_000_001),
        retryDelayMs: 0,
      },
    ).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Error)
    if (error instanceof Error) expect(error.cause).toBe(tokenError)
    expect(isLikelyContextOverflowTimeout(error, 2_000_001)).toBe(false)
    expect(tokenRequests).toBe(3)
    expect(apiRequests).toBe(1)
  })

  test.each([401, 403])(
    "preserves the original auth response when renewal returns %i",
    async (status) => {
      state.copilotToken = "stale-token"
      state.githubToken = "invalid-github-token"
      spyOn(utils, "sleep").mockResolvedValue(undefined)
      let tokenRequests = 0
      let apiRequests = 0
      globalThis.fetch = mock((url: string) => {
        if (url.includes("/copilot_internal/v2/token")) {
          tokenRequests++
          return new Response("invalid github credentials", { status })
        }
        apiRequests++
        return new Response("original auth failure", { status: 403 })
      }) as unknown as typeof fetch

      const response = await copilotFetch(
        "https://api.githubcopilot.com/responses",
        {
          headers: { Authorization: "Bearer stale-token" },
          retryDelayMs: 0,
        },
      )

      expect(response.status).toBe(403)
      expect(await response.text()).toBe("original auth failure")
      expect(tokenRequests).toBe(1)
      expect(apiRequests).toBe(1)
    },
  )
})
