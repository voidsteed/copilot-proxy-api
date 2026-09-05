import { fetch as builtinFetch } from "bun"
import { afterEach, describe, expect, test } from "bun:test"

import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { getCopilotToken } from "~/services/github/get-copilot-token"
import { getGitHubUser } from "~/services/github/get-user"

const originalFetch = globalThis.fetch
const originalGitHubToken = state.githubToken
const originalVsCodeVersion = state.vsCodeVersion
const tokenPath = "/copilot_internal/v2/token"
const tokenResponse = {
  token: "local-copilot-token",
  expires_at: 2_000_000_000,
  refresh_in: 1800,
}

let server: ReturnType<typeof Bun.serve> | undefined

afterEach(async () => {
  globalThis.fetch = originalFetch
  state.githubToken = originalGitHubToken
  state.vsCodeVersion = originalVsCodeVersion
  const activeServer = server
  server = undefined
  await activeServer?.stop(true)
})

function serveGitHub(
  handler: (request: Request) => Response | Promise<Response>,
) {
  const localServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: handler,
  })
  server = localServer
  state.githubToken = "local-github-token"
  state.vsCodeVersion = "test-editor"

  // Keep real network and abort behavior; only redirect GitHub to a local fixture.
  globalThis.fetch = ((input, init) => {
    const upstream = new URL(input instanceof Request ? input.url : input)
    if (upstream.origin !== "https://api.github.com") {
      throw new Error(`Unexpected upstream: ${upstream.origin}`)
    }
    return builtinFetch(new URL(upstream.pathname, localServer.url), init)
  }) as typeof fetch
}

function successfulResponse(request: Request) {
  return new URL(request.url).pathname === tokenPath ?
      Response.json(tokenResponse)
    : Response.json({ login: "local-user" })
}

describe("GitHub request deadlines", () => {
  test("bounds stalled token and user requests through headers and JSON, then recovers", async () => {
    const visits = new Map<string, number>()
    const stalledHeaders = Promise.withResolvers<Response>()
    let recovered = false
    let guard: ReturnType<typeof setTimeout> | undefined

    serveGitHub((request) => {
      if (recovered) return successfulResponse(request)
      const path = new URL(request.url).pathname
      const count = visits.get(path) ?? 0
      visits.set(path, count + 1)
      if (count === 0) return stalledHeaders.promise
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"partial":'))
          },
        }),
        { headers: { "content-type": "application/json" } },
      )
    })

    try {
      const requests = Promise.allSettled([
        getCopilotToken(),
        getGitHubUser(),
        getCopilotToken(),
        getGitHubUser(),
      ])
      const outcomes = await Promise.race([
        requests,
        new Promise<string>((resolve) => {
          guard = setTimeout(() => resolve("deadline missed"), 12_000)
        }),
      ])

      expect(outcomes).not.toBe("deadline missed")
      if (typeof outcomes === "string") return
      for (const outcome of outcomes) {
        expect(outcome).toMatchObject({
          status: "rejected",
          reason: { name: "TimeoutError" },
        })
      }

      recovered = true
      expect(await getCopilotToken()).toEqual(tokenResponse)
      expect(await getGitHubUser()).toEqual({ login: "local-user" })
    } finally {
      clearTimeout(guard)
      stalledHeaders.resolve(new Response(null, { status: 503 }))
    }
  }, 15_000)

  test("preserves successful JSON and authentication headers", async () => {
    const requests: Array<{ path: string; headers: Headers }> = []
    serveGitHub((request) => {
      requests.push({
        path: new URL(request.url).pathname,
        headers: request.headers,
      })
      return successfulResponse(request)
    })

    expect(await getCopilotToken()).toEqual(tokenResponse)
    expect(await getGitHubUser()).toEqual({ login: "local-user" })
    expect(requests.map(({ path }) => path)).toEqual([tokenPath, "/user"])
    for (const { headers } of requests) {
      expect(headers.get("authorization")).toBe("token local-github-token")
      expect(headers.get("accept")).toBe("application/json")
      expect(headers.get("content-type")).toBe("application/json")
    }
    expect(requests[0].headers.get("editor-version")).toBe("vscode/test-editor")
  })

  test("preserves HTTP errors and their readable response bodies", async () => {
    serveGitHub(() =>
      Response.json({ message: "Bad credentials" }, { status: 401 }),
    )

    const outcomes = await Promise.allSettled([
      getCopilotToken(),
      getGitHubUser(),
    ])
    for (const [index, outcome] of outcomes.entries()) {
      expect(outcome.status).toBe("rejected")
      if (outcome.status !== "rejected") continue
      const error: unknown = outcome.reason
      expect(error).toBeInstanceOf(HTTPError)
      if (!(error instanceof HTTPError)) continue
      expect(error.message).toBe(
        index === 0 ?
          "Failed to get Copilot token"
        : "Failed to get GitHub user",
      )
      expect(error.response.status).toBe(401)
      expect(await error.response.json()).toEqual({
        message: "Bad credentials",
      })
    }
  })
})
