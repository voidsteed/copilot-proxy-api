import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"

import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import {
  getCopilotTokenWithRetry,
  logUser,
  refreshCopilotToken,
  setupCopilotToken,
} from "~/lib/token"
import * as utils from "~/lib/utils"

const originalFetch = globalThis.fetch
const originalSetTimeout = globalThis.setTimeout
let refreshTimer: ReturnType<typeof setInterval> | undefined

afterEach(() => {
  globalThis.fetch = originalFetch
  mock.restore()
  state.githubToken = undefined
  state.copilotToken = undefined
  clearInterval(refreshTimer)
  refreshTimer = undefined
})

describe("refreshCopilotToken", () => {
  test("shares transient recovery across concurrent refresh callers", async () => {
    state.githubToken = "saved-token"
    state.copilotToken = "stale-token"
    spyOn(utils, "sleep").mockResolvedValue(undefined)
    let tokenRequests = 0
    globalThis.fetch = mock(() => {
      tokenRequests++
      return tokenRequests === 1 ?
          new Response("unavailable", { status: 503 })
        : Response.json({
            token: "fresh-token",
            refresh_in: 1800,
            expires_at: 2_000_000_000,
          })
    }) as unknown as typeof fetch

    const first = refreshCopilotToken("stale-token")
    const second = refreshCopilotToken("stale-token")
    const tokens = await Promise.all([first, second])

    expect(tokens).toEqual(["fresh-token", "fresh-token"])
    expect(state.copilotToken).toBe("fresh-token")
    expect(tokenRequests).toBe(2)
  })

  test("uses an already refreshed token without requesting another", async () => {
    state.copilotToken = "fresh-token"
    let tokenRequests = 0
    globalThis.fetch = mock(() => {
      tokenRequests++
      return new Response("unexpected request", { status: 500 })
    }) as unknown as typeof fetch

    expect(await refreshCopilotToken("stale-token")).toBe("fresh-token")
    expect(tokenRequests).toBe(0)
  })

  test("clears an exhausted shared refresh so a later refresh can recover", async () => {
    state.githubToken = "saved-token"
    state.copilotToken = "stale-token"
    spyOn(utils, "sleep").mockResolvedValue(undefined)
    let tokenRequests = 0
    globalThis.fetch = mock(() => {
      tokenRequests++
      return tokenRequests <= 3 ?
          new Response(`unavailable ${tokenRequests}`, { status: 503 })
        : Response.json({
            token: "recovered-token",
            refresh_in: 1800,
            expires_at: 2_000_000_000,
          })
    }) as unknown as typeof fetch

    const results = await Promise.allSettled([
      refreshCopilotToken("stale-token"),
      refreshCopilotToken("stale-token"),
    ])

    expect(tokenRequests).toBe(3)
    expect(state.copilotToken).toBe("stale-token")
    for (const result of results) {
      expect(result.status).toBe("rejected")
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(HTTPError)
      }
    }
    expect(await refreshCopilotToken("stale-token")).toBe("recovered-token")
    expect(state.copilotToken).toBe("recovered-token")
    expect(tokenRequests).toBe(4)
  })

  test.each([401, 403])(
    "does not retry token authentication status %i",
    async (status) => {
      state.githubToken = "invalid-token"
      state.copilotToken = "stale-token"
      spyOn(utils, "sleep").mockResolvedValue(undefined)
      let tokenRequests = 0
      globalThis.fetch = mock(() => {
        tokenRequests++
        return new Response("invalid credentials", { status })
      }) as unknown as typeof fetch

      const error = await refreshCopilotToken("stale-token").catch(
        (error: unknown) => error,
      )
      expect(error).toBeInstanceOf(HTTPError)
      expect(state.copilotToken).toBe("stale-token")
      expect(tokenRequests).toBe(1)
    },
  )
})

async function startRefresh(
  responseForAttempt: (attempt: number) => Response,
  { joinOnDemand = false } = {},
) {
  state.githubToken = "saved-token"
  const delays: Array<number> = []
  const timeout = setTimeout(() => {}, 2_000_000_000)
  clearTimeout(timeout)
  const immediateTimeout = Object.assign(
    (callback: () => void, delay?: number) => {
      if (delay !== undefined && delay <= 8000) {
        delays.push(delay)
        queueMicrotask(callback)
        return timeout
      }
      return originalSetTimeout(callback, delay)
    },
    { __promisify__: originalSetTimeout.__promisify__ },
  )
  spyOn(globalThis, "setTimeout").mockImplementation(immediateTimeout)
  // Keep the scheduler idle until the test explicitly runs its callback.
  refreshTimer = setInterval(() => {}, 2_000_000_000)
  const timer = refreshTimer
  let refresh: (() => void) | undefined
  spyOn(globalThis, "setInterval").mockImplementation(
    (callback: () => void) => {
      refresh = callback
      return timer
    },
  )
  let tokenRequests = 0
  let activeRequests = 0
  let peakRequests = 0
  globalThis.fetch = mock(async () => {
    activeRequests++
    peakRequests = Math.max(peakRequests, activeRequests)
    await Promise.resolve()
    activeRequests--
    tokenRequests++
    return tokenRequests === 1 ?
        Response.json({
          token: "startup-token",
          refresh_in: 1800,
          expires_at: 2_000_000_000,
        })
      : responseForAttempt(tokenRequests - 1)
  }) as unknown as typeof fetch

  await setupCopilotToken()
  expect(state.copilotToken).toBe("startup-token")
  if (!refresh) throw new Error("Scheduled refresh was not registered")
  const onDemand =
    joinOnDemand ?
      refreshCopilotToken("startup-token").catch((error: unknown) => error)
    : undefined
  refresh()
  await Bun.sleep(0)

  return { tokenRequests, delays, peakRequests, onDemandResult: await onDemand }
}

describe("scheduled Copilot token refresh", () => {
  test("keeps five exponential transient attempts without nested retries", async () => {
    const { tokenRequests, delays } = await startRefresh((attempt) =>
      attempt < 5 ?
        new Response("unavailable", { status: 503 })
      : Response.json({
          token: "renewed-token",
          refresh_in: 1800,
          expires_at: 2_000_000_000,
        }),
    )

    expect(state.copilotToken).toBe("renewed-token")
    expect(tokenRequests).toBe(6)
    expect(delays).toEqual([1000, 2000, 4000, 8000])
  })

  test("keeps the old token after scheduled transient retries are exhausted", async () => {
    const { tokenRequests } = await startRefresh(
      () => new Response("unavailable", { status: 503 }),
    )

    expect(state.copilotToken).toBe("startup-token")
    expect(tokenRequests).toBe(6)
  })

  test("preserves five attempts when the scheduler joins an on-demand refresh", async () => {
    const { tokenRequests, delays, peakRequests, onDemandResult } =
      await startRefresh(
        (attempt) =>
          attempt < 5 ?
            new Response("unavailable", { status: 503 })
          : Response.json({
              token: "renewed-token",
              refresh_in: 1800,
              expires_at: 2_000_000_000,
            }),
        { joinOnDemand: true },
      )

    expect(state.copilotToken).toBe("renewed-token")
    expect(onDemandResult).toBe("renewed-token")
    expect(tokenRequests).toBe(6)
    expect(peakRequests).toBe(1)
    expect(delays).toEqual([1000, 2000, 4000, 8000])
  })

  test("bounds a promoted shared refresh and clears its policy after failure", async () => {
    const { tokenRequests, peakRequests, onDemandResult } = await startRefresh(
      () => new Response("unavailable", { status: 503 }),
      { joinOnDemand: true },
    )

    expect(onDemandResult).toBeInstanceOf(HTTPError)
    expect(tokenRequests).toBe(6)
    expect(peakRequests).toBe(1)
    expect(state.copilotToken).toBe("startup-token")

    let nextRequests = 0
    globalThis.fetch = mock(() => {
      nextRequests++
      return new Response("still unavailable", { status: 503 })
    }) as unknown as typeof fetch
    const error = await refreshCopilotToken("startup-token").catch(
      (error: unknown) => error,
    )

    expect(error).toBeInstanceOf(HTTPError)
    expect(nextRequests).toBe(3)
  })

  test.each([401, 403])(
    "does not repeatedly renew invalid credentials after status %i",
    async (status) => {
      const { tokenRequests } = await startRefresh(
        () => new Response("invalid credentials", { status }),
      )

      expect(state.copilotToken).toBe("startup-token")
      expect(tokenRequests).toBe(2)
    },
  )
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
