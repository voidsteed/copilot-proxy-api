import { describe, expect, test } from "bun:test"
import { createServer, type ServerResponse } from "node:http"

import { probeLegacyProxy } from "~/lib/legacy-proxy"
import {
  legacySnapshotSchema,
  nativeConnectionSchema,
} from "~/lib/proxy-contracts"

const usage = {
  copilot_plan: "individual",
  quota_snapshots: {
    premium_interactions: { unlimited: false, entitlement: 100, remaining: 75 },
  },
}
function trace(id: string) {
  return {
    id,
    method: "POST",
    path: "/v1/responses",
    status: 200,
    durationMs: 8,
    startedAt: "2026-10-30T12:00:00.000Z",
  }
}
async function waitFor(check: () => boolean, timeout = 1000): Promise<void> {
  const startedAt = performance.now()
  while (!check()) {
    if (performance.now() - startedAt > timeout)
      throw new Error("The HTTP fixture did not reach the expected state")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
async function fixture() {
  let history = [trace("initial")]
  let reply:
    | { kind: "hang" }
    | { kind: "json"; body: unknown }
    | { kind: "delayed-json"; body: unknown; delayMs: number } = {
    kind: "json",
    body: usage,
  }
  let usageCount = 0
  const active = new Set<ServerResponse>()
  const server = createServer((request, response) => {
    request.resume()
    if (request.url === "/") {
      response.end("Server running")
      return
    }
    if (request.url === "/models") {
      response.end(JSON.stringify({ object: "list", data: [] }))
      return
    }
    if (request.url === "/debug/requests") {
      response.end(JSON.stringify({ object: "list", data: history }))
      return
    }
    if (request.url !== "/usage") {
      response.statusCode = 404
      response.end()
      return
    }
    usageCount++
    active.add(response)
    response.once("close", () => active.delete(response))
    if (reply.kind === "hang") {
      response.flushHeaders()
      return
    }
    const body = JSON.stringify(reply.body)
    if (reply.kind === "json") {
      response.end(body)
      return
    }
    const timer = setTimeout(() => response.end(body), reply.delayMs)
    response.once("close", () => clearTimeout(timer))
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("No fixture port")
  const rootUrl = `http://127.0.0.1:${address.port}`
  return {
    connection: nativeConnectionSchema.parse({
      rootUrl,
      apiUrl: `${rootUrl}/v1`,
      authentication: { kind: "none" },
    }),
    count: (_path: "/usage") => usageCount,
    activeCount: (_path: "/usage") => active.size,
    setReply(_path: "/usage", next: typeof reply) {
      reply = next
    },
    finishUsage(body: unknown = usage) {
      for (const response of active) response.end(JSON.stringify(body))
    },
    replaceHistory(records: typeof history) {
      history = records
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
  }
}

describe("legacy quota refresh regressions", () => {
  test("accepts quota taking 4.525 seconds while background local observations stay current", async () => {
    const server = await fixture()
    server.setReply("/usage", {
      kind: "delayed-json",
      delayMs: 4525,
      body: { ...usage, copilot_plan: "business" },
    })
    const session = await probeLegacyProxy({ connection: server.connection })
    if (!session) throw new Error("Expected local session")
    try {
      const snapshots: Array<Awaited<ReturnType<typeof session.read>>> = []
      session.subscribe((snapshot) => snapshots.push(snapshot))
      const reads = [session.read(), session.read(), session.read()]
      server.replaceHistory([trace("during-slow-quota")])
      await waitFor(
        () =>
          snapshots.some((snapshot) =>
            snapshot.activity.some(
              (record) => record.id === "during-slow-quota",
            ),
          ),
        2600,
      )
      expect(snapshots.at(-1)?.usage).toBeNull()
      expect(server.activeCount("/usage")).toBe(1)
      for (const snapshot of await Promise.all(reads)) {
        expect(snapshot.status).toBe("reachable")
        expect(snapshot.usage?.plan).toBe("business")
      }
      expect(server.count("/usage")).toBe(1)
      expect(
        snapshots.every((snapshot) => snapshot.status === "reachable"),
      ).toBe(true)
    } finally {
      await session.release()
      await server.close()
    }
  }, 7000)

  test("throttles quota refreshes on default reads while explicit refreshQuota bypasses the cooldown and preserves failures", async () => {
    const server = await fixture()
    const session = await probeLegacyProxy({ connection: server.connection })
    if (!session) throw new Error("Expected local session")
    try {
      const initial = await session.read()
      expect(server.count("/usage")).toBe(1)
      await session.read()
      await session.read()
      expect(server.count("/usage")).toBe(1)
      server.setReply("/usage", { kind: "hang" })
      const reads = [
        session.read({ refreshQuota: true }),
        session.read({ refreshQuota: true }),
        session.read({ refreshQuota: true }),
      ]
      await waitFor(() => server.activeCount("/usage") === 1)
      expect(server.count("/usage")).toBe(2)
      server.finishUsage({ unrelated: true })
      for (const failed of await Promise.all(reads)) {
        expect(failed.status).toBe("reachable")
        expect(failed.usage).toEqual(initial.usage)
      }
      server.setReply("/usage", {
        kind: "json",
        body: {
          ...usage,
          copilot_plan: "business",
          quota_snapshots: {
            premium_interactions: {
              unlimited: false,
              entitlement: 100,
              remaining: 42,
            },
          },
        },
      })
      const recovered = await session.read({ refreshQuota: true })
      expect(server.count("/usage")).toBe(3)
      expect(recovered.usage?.plan).toBe("business")
      expect(recovered.usage?.quotas[0]).toMatchObject({ remaining: 42 })
      expect(
        Date.parse(recovered.usage?.fetchedAt ?? ""),
      ).toBeGreaterThanOrEqual(Date.parse(initial.usage?.fetchedAt ?? ""))
    } finally {
      await session.release()
      await server.close()
    }
  })

  test("quota timeout preserves the last successful observation while local polling continues", async () => {
    const server = await fixture()
    const session = await probeLegacyProxy({ connection: server.connection })
    if (!session) throw new Error("Expected local session")
    try {
      const initial = await session.read()
      server.setReply("/usage", { kind: "hang" })
      const snapshots: Array<Awaited<ReturnType<typeof session.read>>> = []
      session.subscribe((snapshot) => snapshots.push(snapshot))
      const pending = session.read({ refreshQuota: true })
      await waitFor(() => server.activeCount("/usage") === 1)
      server.replaceHistory([trace("during-quota-timeout")])
      await waitFor(
        () =>
          snapshots.some((snapshot) =>
            snapshot.activity.some(
              (record) => record.id === "during-quota-timeout",
            ),
          ),
        2600,
      )
      const timedOut = await pending
      expect(timedOut.status).toBe("reachable")
      expect(timedOut.usage).toEqual(initial.usage)
      expect(timedOut.activity.map((record) => record.id)).toContain(
        "during-quota-timeout",
      )
      expect(
        snapshots.every((snapshot) => snapshot.status === "reachable"),
      ).toBe(true)
      expect(server.count("/usage")).toBe(2)
    } finally {
      await session.release()
      await server.close()
    }
  }, 15_000)
})

describe("legacy retained activity chronology", () => {
  test("orders offset timestamps by instant and retains repeated IDs by timestamp within the recent cap", async () => {
    const server = await fixture()
    server.replaceHistory([
      { ...trace("repeated"), startedAt: "2026-11-04T01:30:00-07:00" },
      { ...trace("repeated"), startedAt: "2026-11-04T01:15:00-08:00" },
      { ...trace("utc"), startedAt: "2026-11-04T09:00:00Z" },
    ])
    const session = await probeLegacyProxy({ connection: server.connection })
    if (!session) throw new Error("Expected local session")
    try {
      const initial = await session.read()
      expect(initial.activity.map((record) => record.startedAt)).toEqual([
        "2026-11-04T01:15:00-08:00",
        "2026-11-04T09:00:00Z",
        "2026-11-04T01:30:00-07:00",
      ])
      server.replaceHistory([
        {
          ...trace("repeated"),
          startedAt: "2026-11-04T01:15:00-08:00",
          status: 201,
        },
        ...Array.from({ length: 205 }, (_, index) => ({
          ...trace(`older-${index}`),
          startedAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
        })),
      ])
      const retained = await session.read()
      expect(retained.activity).toHaveLength(200)
      expect(retained.activity.slice(0, 3).map((record) => record.id)).toEqual([
        "repeated",
        "utc",
        "repeated",
      ])
      expect(retained.activity[0]?.status).toBe(201)
      expect(retained.activity.at(-1)?.id).toBe("older-8")
      expect(
        retained.activity.filter((record) => record.id === "repeated"),
      ).toHaveLength(2)
    } finally {
      await session.release()
      await server.close()
    }
  })
})

describe("legacy tolerant parsing and endpoint fallbacks", () => {
  test("defaults omitted supported_endpoints and tolerates nullish or individual malformed catalog, quota and trace entries", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        switch (new URL(request.url).pathname) {
          case "/": {
            return new Response("Server running")
          }
          case "/models": {
            return Response.json({
              object: "list",
              data: [
                {
                  id: "chat-default-endpoints",
                  name: "Chat Default",
                  vendor: "OpenAI",
                  preview: null,
                  supported_endpoints: null,
                  capabilities: {
                    family: "gpt",
                    type: "chat",
                    limits: {
                      max_context_window_tokens: null,
                      max_output_tokens: null,
                    },
                    supports: {
                      tool_calls: null,
                      vision: null,
                      streaming: true,
                      adaptive_thinking: null,
                      reasoning_effort: null,
                    },
                  },
                },
                {
                  id: "embed-default-endpoints",
                  object: "model",
                  display_name: "Embedding Model",
                  owned_by: "OpenAI",
                  capabilities: {
                    family: "text-embedding",
                    type: "embeddings",
                    limits: null,
                    supports: null,
                  },
                },
                { id: "malformed-model-skipped" },
              ],
            })
          }
          case "/usage": {
            return Response.json({
              copilot_plan: "pro",
              quota_reset_date: null,
              quota_snapshots: {
                chat: {
                  unlimited: true,
                  entitlement: -1,
                  remaining: null,
                  percent_remaining: null,
                },
                premium_interactions: {
                  unlimited: false,
                  entitlement: 100,
                  remaining: -5,
                  percent_remaining: null,
                },
                negative_entitlement: {
                  unlimited: false,
                  entitlement: -1,
                  remaining: 0,
                },
                malformed_null: null,
                malformed_object: { unrelated: true },
              },
            })
          }
          case "/debug/requests": {
            return Response.json({
              object: "list",
              data: [
                { ...trace("valid-null-duration"), durationMs: null },
                { id: "malformed-trace-skipped" },
              ],
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
      expect(session).not.toBeNull()
      if (!session) throw new Error("Expected tolerant legacy session")
      const snapshot = legacySnapshotSchema.parse(await session.read())
      expect(snapshot.status).toBe("reachable")
      expect(snapshot.catalog).toEqual([
        {
          id: "chat-default-endpoints",
          name: "Chat Default",
          vendor: "OpenAI",
          contextWindow: null,
          maxOutput: null,
          supports: ["streaming"],
          endpoints: ["/chat/completions", "/responses"],
          preview: false,
        },
        {
          id: "embed-default-endpoints",
          name: "Embedding Model",
          vendor: "OpenAI",
          contextWindow: null,
          maxOutput: null,
          supports: [],
          endpoints: ["/embeddings"],
          preview: false,
        },
      ])
      expect(snapshot.usage).toMatchObject({
        plan: "pro",
        resetAt: null,
        quotas: [
          { kind: "unlimited", id: "chat", label: "Chat" },
          {
            kind: "limited",
            id: "premium_interactions",
            label: "Premium requests",
            remaining: 0,
            limit: 100,
            percentRemaining: 0,
          },
        ],
      })
      expect(snapshot.activity.map((record) => record.id)).toEqual([
        "valid-null-duration",
      ])
      expect(snapshot.activity[0]?.durationMs).toBe(0)
    } finally {
      await session?.release()
      await server.stop(true)
    }
  })
})
