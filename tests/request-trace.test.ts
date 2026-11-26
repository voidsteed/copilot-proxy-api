import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { clearRequestTraces, requestTraceMiddleware } from "~/lib/request-trace"
import { debugRoutes } from "~/routes/debug/route"

beforeEach(() => {
  clearRequestTraces()
})

afterEach(() => {
  clearRequestTraces()
})

function requestWithRawHeaders(
  url: string,
  headers: Record<string, string>,
): Request {
  const request = new Request(url)
  const map = new Map<string, string>(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  )
  Object.defineProperty(request, "headers", {
    value: {
      get: (name: string) => map.get(name.toLowerCase()) ?? null,
      has: (name: string) => map.has(name.toLowerCase()),
      forEach: (callback: (value: string, key: string) => void) => {
        for (const [key, value] of map) callback(value, key)
      },
      entries: () => map.entries(),
      keys: () => map.keys(),
      values: () => map.values(),
      [Symbol.iterator]: () => map.entries(),
    },
  })
  return request
}

describe("requestTraceMiddleware", () => {
  test("adds request id headers and stores recent request metadata", async () => {
    const app = new Hono()
    app.use(requestTraceMiddleware)
    app.get("/ok", (c) => c.text("ok"))
    app.route("/debug", debugRoutes)

    const response = await app.request("/ok", {
      headers: { "x-client-request-id": "client-123" },
    })
    const debugResponse = await app.request("/debug/requests")
    const debugBody = (await debugResponse.json()) as {
      data: Array<{ id: string; method: string; path: string; status: number }>
    }

    expect(response.headers.get("x-request-id")).toBe("client-123")
    expect(response.headers.get("request-id")).toBe("client-123")
    expect(debugBody.data[0]).toMatchObject({
      id: "client-123",
      method: "GET",
      path: "/ok",
      status: 200,
    })
  })

  test("keeps only the most recent request traces", async () => {
    const app = new Hono()
    app.use(requestTraceMiddleware)
    app.get("/ok", (c) => c.text("ok"))
    app.route("/debug", debugRoutes)

    for (let index = 0; index < 105; index++) {
      await app.request(`/ok?index=${index}`, {
        headers: { "x-client-request-id": `request-${index}` },
      })
    }

    const debugResponse = await app.request("/debug/requests")
    const debugBody = (await debugResponse.json()) as {
      data: Array<{ id: string }>
    }

    expect(debugBody.data).toHaveLength(100)
    expect(debugBody.data[0].id).toBe("request-104")
    expect(debugBody.data.at(-1)?.id).toBe("request-5")
  })

  test("stores sanitized client metadata and omits empty client fields", async () => {
    const app = new Hono()
    app.use(requestTraceMiddleware)
    app.get("/ok", (c) => c.text("ok"))
    app.route("/debug", debugRoutes)

    await app.fetch(
      requestWithRawHeaders("http://localhost/ok", {
        "user-agent": "OpenAI/JS 4.80.0\nFORGED",
        origin: "http://localhost:3000",
        "x-forwarded-for": "::ffff:100.64.225.91, 10.0.0.1",
      }),
    )

    const debugResponse = await app.request("/debug/requests")
    const debugBody = (await debugResponse.json()) as {
      data: Array<{
        id: string
        client?: {
          userAgent?: string
          origin?: string
          remoteAddress?: string
        }
      }>
    }

    const client = debugBody.data[0]?.client
    expect(client).toBeDefined()
    expect(client?.userAgent).toContain("OpenAI/JS 4.80.0")
    expect(client?.userAgent).not.toContain("\n")
    expect(client?.origin).toBe("http://localhost:3000")
    expect(client?.remoteAddress).toBe("100.64.225.91")

    await app.request("/ok")
    const headerlessResponse = await app.request("/debug/requests")
    const headerlessBody = (await headerlessResponse.json()) as {
      data: Array<{
        id: string
        client?: {
          userAgent?: string
          origin?: string
          remoteAddress?: string
        }
      }>
    }

    expect(headerlessBody.data[0]?.client).toBeUndefined()
  })
})
