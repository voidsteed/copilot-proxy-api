import { expect, test } from "bun:test"

import { probeLegacyProxy } from "~/lib/legacy-proxy"
import { nativeConnectionSchema } from "~/lib/proxy-contracts"

function trace(id: string, path: string, method = "POST") {
  return {
    id,
    path,
    method,
    status: 200,
    durationMs: 8,
    startedAt: "2026-10-30T12:00:00.000Z",
  }
}

test("legacy history observes Google generation once and excludes catalog/non-inference paths", async () => {
  const history = [
    trace("google-unary", "/v1beta/models/gemini-3-flash:generateContent"),
    trace(
      "google-stream",
      "/v1beta/models/gemini-3-flash:streamGenerateContent",
    ),
    trace("google-list", "/v1beta/models", "GET"),
    trace("google-get", "/v1beta/models/gemini-3-flash", "GET"),
    trace(
      "google-wrong-method",
      "/v1beta/models/gemini-3-flash:generateContent",
      "GET",
    ),
    trace(
      "google-extra-path",
      "/v1beta/models/gemini-3-flash:generateContent/extra",
    ),
    trace("embedding", "/v1/embeddings"),
  ]
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      switch (new URL(request.url).pathname) {
        case "/": {
          return new Response("Server running")
        }
        case "/models": {
          return Response.json({ object: "list", data: [] })
        }
        case "/debug/requests": {
          return Response.json({ object: "list", data: history })
        }
        case "/usage": {
          return Response.json({
            copilot_plan: "individual",
            quota_snapshots: { chat: { unlimited: true } },
          })
        }
        default: {
          return new Response(null, { status: 404 })
        }
      }
    },
  })
  const rootUrl = server.url.origin
  const connection = nativeConnectionSchema.parse({
    rootUrl,
    apiUrl: `${rootUrl}/v1`,
    authentication: { kind: "none" },
  })
  const session = await probeLegacyProxy({ connection })
  try {
    if (!session) throw new Error("Expected legacy session")
    const first = await session.read()
    expect(first.activity.map((record) => record.id)).toEqual([
      "google-unary",
      "google-stream",
      "embedding",
    ])
    expect(first.activity.map((record) => record.outcome)).toEqual([
      "observed",
      "observed",
      "observed",
    ])
    expect(first.activity[0]).toMatchObject({
      model: null,
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
    })
    expect((await session.read()).activity).toEqual(first.activity)
  } finally {
    await session?.release()
    await server.stop(true)
  }
})
