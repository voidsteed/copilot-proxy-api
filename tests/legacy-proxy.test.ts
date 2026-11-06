import { describe, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { OpenProxySessionOptions } from "~/lib/proxy-contracts"

import { probeLegacyProxy } from "~/lib/legacy-proxy"
import {
  legacySnapshotSchema,
  nativeConnectionSchema,
} from "~/lib/proxy-contracts"
import { openProxySession } from "~/lib/proxy-session"

const model = {
  id: "claude-sonnet-5.5",
  object: "model",
  display_name: "Claude Sonnet 5.5",
  owned_by: "Anthropic",
  preview: true,
  supported_endpoints: ["/chat/completions", "/responses"],
  capabilities: {
    family: "claude",
    type: "chat",
    limits: { max_context_window_tokens: 200_000, max_output_tokens: 64_000 },
    supports: {
      tool_calls: true,
      streaming: true,
      vision: true,
      reasoning_effort: ["high"],
    },
  },
}
const usage = {
  copilot_plan: "individual",
  quota_reset_date: "2026-11-01",
  quota_snapshots: {
    chat: { unlimited: true },
    premium_interactions: {
      unlimited: false,
      entitlement: 100,
      remaining: 75,
      percent_remaining: 75,
    },
  },
}
function trace(id: string, path = "/v1/responses", method = "POST") {
  return {
    id,
    method,
    path,
    status: 200,
    durationMs: 8,
    startedAt: "2026-10-30T12:00:00.000Z",
  }
}

type FixtureReply =
  | { kind: "json"; body: unknown }
  | { kind: "text"; body: string }
  | { kind: "failure"; status: number }
  | { kind: "hang" }
  | { kind: "redirect" }
  | { kind: "oversize" }
  | { kind: "stream-oversize" }

function fixtureReply(response: ServerResponse, reply: FixtureReply): void {
  switch (reply.kind) {
    case "hang": {
      response.flushHeaders()
      return
    }
    case "json": {
      response.end(JSON.stringify(reply.body))
      return
    }
    case "text": {
      response.end(reply.body)
      return
    }
    case "failure": {
      response.statusCode = reply.status
      response.end()
      return
    }
    case "redirect": {
      response.statusCode = 302
      response.setHeader("location", "http://example.invalid/")
      response.end()
      return
    }
    case "oversize": {
      response.setHeader("content-length", 4_000_001)
      response.end("x")
      return
    }
    case "stream-oversize": {
      response.write("x".repeat(4_000_001))
      response.end()
      return
    }
    default: {
      const exhaustive: never = reply
      throw new Error(`Unsupported fixture response ${String(exhaustive)}`)
    }
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

async function fixture(
  options: {
    key?: string
    greeting?: string
    invalidUsage?: boolean
    invalidCatalog?: boolean
    invalidDebug?: boolean
    hangingUsage?: boolean
    redirect?: boolean
    oversize?: boolean
    missingModelLimits?: boolean
  } = {},
) {
  let history = [
    trace("request-from-terminal"),
    trace("polling", "/debug/requests", "GET"),
  ]
  const methods: Array<string> = []
  const replies = new Map<string, FixtureReply>()
  const counts = new Map<string, number>()
  const active = new Map<string, Set<ServerResponse>>()
  if (options.hangingUsage) replies.set("/usage", { kind: "hang" })
  if (options.invalidCatalog)
    replies.set("/models", {
      kind: "json",
      body: { object: "list", data: [{ id: "unverified-model" }] },
    })
  if (options.invalidDebug)
    replies.set("/debug/requests", {
      kind: "json",
      body: { object: "list", data: [{ id: "unverified-trace" }] },
    })
  const server = createServer((request, response) => {
    methods.push(request.method ?? "")
    request.resume()
    const path = request.url ?? ""
    counts.set(path, (counts.get(path) ?? 0) + 1)
    const responses = active.get(path) ?? new Set<ServerResponse>()
    active.set(path, responses)
    responses.add(response)
    response.once("close", () => responses.delete(response))
    const override = replies.get(path)
    if (override) {
      fixtureReply(response, override)
      return
    }
    if (request.url === "/") {
      response.end(options.greeting ?? "Server running")
      return
    }
    if (
      options.key
      && request.headers.authorization !== `Bearer ${options.key}`
    ) {
      response.statusCode = 401
      response.end()
      return
    }
    if (options.redirect) {
      response.statusCode = 302
      response.setHeader("location", "http://example.invalid/")
      response.end()
      return
    }
    if (options.oversize) {
      response.setHeader("content-length", 4_000_001)
      response.end("x")
      return
    }
    response.setHeader("content-type", "application/json")
    let reply: unknown = { object: "list", data: history }
    if (request.url === "/models")
      reply = {
        object: "list",
        data: [
          model,
          ...(options.missingModelLimits ?
            [
              {
                ...model,
                id: "limits-not-reported",
                capabilities: {
                  family: model.capabilities.family,
                  type: model.capabilities.type,
                  supports: model.capabilities.supports,
                },
              },
            ]
          : []),
        ],
      }
    else if (request.url === "/usage")
      reply = options.invalidUsage ? { unrelated: true } : usage
    response.end(JSON.stringify(reply))
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
  const connection = nativeConnectionSchema.parse({
    rootUrl,
    apiUrl: `${rootUrl}/v1`,
    authentication:
      options.key ? { kind: "keyed", key: options.key } : { kind: "none" },
  })
  return {
    connection,
    methods,
    count(path: string) {
      return counts.get(path) ?? 0
    },
    activeCount(path: string) {
      return active.get(path)?.size ?? 0
    },
    setReply(path: string, reply: FixtureReply) {
      replies.set(path, reply)
    },
    finish(path: string, body: unknown) {
      for (const response of active.get(path) ?? [])
        response.end(JSON.stringify(body))
    },
    finishUsage(body: unknown = usage) {
      for (const response of active.get("/usage") ?? [])
        response.end(JSON.stringify(body))
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

describe("legacy proxy catalog without reported limits", () => {
  test("attaches with the complete catalog when some models omit token limits", async () => {
    const server = await fixture({ missingModelLimits: true })
    let session: Awaited<ReturnType<typeof probeLegacyProxy>> = null
    try {
      session = await probeLegacyProxy({ connection: server.connection })
      expect(session).not.toBeNull()
      if (!session) throw new Error("Expected legacy session")
      const snapshot = await session.read()
      expect(snapshot.catalog).toHaveLength(2)
      expect(snapshot.catalog[1]).toEqual({
        id: "limits-not-reported",
        name: model.display_name,
        vendor: model.owned_by,
        preview: true,
        contextWindow: null,
        maxOutput: null,
        endpoints: model.supported_endpoints,
        supports: ["tools", "vision", "streaming", "reasoning"],
      })
    } finally {
      await session?.release()
      await server.close()
    }
  })
})

describe("legacy proxy observation", () => {
  test("imports full catalog/quota and truthful inference activity, retaining rows after polls fill the ring", async () => {
    const server = await fixture()
    const session = await probeLegacyProxy({ connection: server.connection })
    expect(session?.kind).toBe("legacy")
    if (!session) throw new Error("Expected legacy session")
    try {
      const snapshot = legacySnapshotSchema.parse(await session.read())
      expect(snapshot.catalog).toEqual([
        {
          id: model.id,
          name: model.display_name,
          vendor: "Anthropic",
          preview: true,
          contextWindow: 200_000,
          maxOutput: 64_000,
          endpoints: ["/chat/completions", "/responses"],
          supports: ["tools", "vision", "streaming", "reasoning"],
        },
      ])
      expect(snapshot.usage?.quotas).toEqual([
        { kind: "unlimited", id: "chat", label: "Chat" },
        {
          kind: "limited",
          id: "premium_interactions",
          label: "Premium requests",
          remaining: 75,
          limit: 100,
          percentRemaining: 75,
        },
      ])
      expect(snapshot.activity).toEqual([
        {
          ...trace("request-from-terminal"),
          outcome: "observed",
          model: null,
          inputTokens: null,
          outputTokens: null,
          cachedTokens: null,
        },
      ])
      expect(snapshot.totals).toEqual({
        requests: null,
        errors: null,
        inputTokens: null,
        outputTokens: null,
        cachedTokens: null,
      })
      server.replaceHistory([trace("monitor", "/models", "GET")])
      expect((await session.read()).activity).toEqual(snapshot.activity)
      server.replaceHistory([trace("request-from-terminal")])
      expect((await session.read()).activity).toHaveLength(1)
      expect(new Set(server.methods)).toEqual(new Set(["GET"]))
      expect("invoke" in session).toBe(false)
      await session.release()
      expect(await (await fetch(server.connection.rootUrl)).text()).toBe(
        "Server running",
      )
    } finally {
      await session.release()
      await server.close()
    }
  })

  test("verifies saved authentication and exposes its mode without the key", async () => {
    const server = await fixture({ key: "fixture-actual-key" })
    try {
      const unkeyed = nativeConnectionSchema.parse({
        ...server.connection,
        authentication: { kind: "none" },
      })
      expect(await probeLegacyProxy({ connection: unkeyed })).toBeNull()
      const session = await probeLegacyProxy({ connection: server.connection })
      expect(session).not.toBeNull()
      if (!session) throw new Error("Expected keyed legacy session")
      expect((await session.read()).connection.authentication).toEqual({
        kind: "keyed",
      })
      expect(JSON.stringify(session)).not.toContain("fixture-actual-key")
      expect(JSON.stringify(await session.read())).not.toContain(
        "fixture-actual-key",
      )
      await session.release()
    } finally {
      await server.close()
    }
  })

  test("rejects unrelated greetings, invalid essential schemas, redirects and oversized bodies", async () => {
    for (const options of [
      { greeting: "Hello" },
      { invalidCatalog: true },
      { invalidDebug: true },
      { redirect: true },
      { oversize: true },
    ]) {
      const server = await fixture(options)
      try {
        expect(
          await probeLegacyProxy({ connection: server.connection }),
        ).toBeNull()
      } finally {
        await server.close()
      }
    }
  })

  test("reports loss of reachability while retaining the observations", async () => {
    const server = await fixture()
    const session = await probeLegacyProxy({ connection: server.connection })
    if (!session) throw new Error("Expected session")
    const snapshots: Array<string> = []
    const unsubscribe = session.subscribe((snapshot) => {
      snapshots.push(snapshot.status)
    })
    await server.close()
    expect((await session.read()).status).toBe("unreachable")
    expect((await session.read()).activity[0]?.id).toBe("request-from-terminal")
    expect(snapshots).toContain("reachable")
    expect(snapshots).toContain("unreachable")
    unsubscribe()
    await session.release()
  })

  test("an explicit legacy key must actually authenticate, rather than matching a keyed-mode label", async () => {
    const server = await fixture({ key: "fixture-actual-key" })
    const homeDirectory = await mkdtemp(join(tmpdir(), "copilot-legacy-key-"))
    try {
      await mkdir(join(homeDirectory, ".claude"))
      await writeFile(
        join(homeDirectory, ".claude", "settings.json"),
        JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: server.connection.rootUrl,
            ANTHROPIC_AUTH_TOKEN: "fixture-actual-key",
          },
        }),
      )
      const port = Number(new URL(server.connection.rootUrl).port)
      const shared: Omit<OpenProxySessionOptions, "intent"> = {
        homeDirectory,
        stateDirectory: join(homeDirectory, "native"),
        discovery: {
          configuredAgents: [],
          savedRuntime: {
            port,
            accountType: "individual",
            manualApprove: false,
            rateLimitSeconds: null,
            rateLimitWait: false,
            responsesContextTrim: false,
            proxyFromEnvironment: false,
          },
        },
      }
      const session = await openProxySession({
        ...shared,
        intent: {
          kind: "ensure-running",
          explicit: {
            authentication: { kind: "keyed", keys: ["fixture-actual-key"] },
          },
          credential: { kind: "native-saved-account" },
        },
      })
      expect(session.kind).toBe("legacy")
      if (session.kind === "legacy") await session.release()
      const rejected = await openProxySession({
        ...shared,
        intent: {
          kind: "ensure-running",
          explicit: {
            authentication: { kind: "keyed", keys: ["fixture-wrong-key"] },
          },
          credential: { kind: "native-saved-account" },
        },
      })
      expect(rejected.kind).toBe("unavailable")
      expect(new Set(server.methods)).toEqual(new Set(["GET"]))
    } finally {
      await server.close()
      await rm(homeDirectory, { recursive: true, force: true })
    }
  })
})

describe("legacy local health independent of quota", () => {
  test("identifies local CLI while quota hangs and publishes repeated local health", async () => {
    const server = await fixture({ hangingUsage: true })
    const abort = new AbortController()
    const deadline = setTimeout(() => abort.abort(), 600)
    let session: Awaited<ReturnType<typeof probeLegacyProxy>> = null
    try {
      session = await probeLegacyProxy({
        connection: server.connection,
        signal: abort.signal,
      })
      clearTimeout(deadline)
      expect(session).not.toBeNull()
      if (!session) throw new Error("Expected local identity without quota")
      const snapshots: Array<{
        status: string
        activity: Array<{ id: string }>
      }> = []
      session.subscribe((snapshot) => snapshots.push(snapshot))
      expect(snapshots[0]?.status).toBe("reachable")
      await waitFor(() => server.count("/usage") === 1)
      server.replaceHistory([trace("next-local-request")])
      await waitFor(
        () =>
          snapshots.some((snapshot) =>
            snapshot.activity.some(
              (record) => record.id === "next-local-request",
            ),
          ),
        2600,
      )
      expect(server.count("/usage")).toBe(1)
      expect(
        snapshots.every((snapshot) => snapshot.status === "reachable"),
      ).toBe(true)
      const read = session.read()
      abort.abort()
      const snapshot = await read
      expect(snapshot.status).toBe("reachable")
      expect(snapshot.usage).toBeNull()
      expect(server.count("/usage")).toBe(1)
    } finally {
      clearTimeout(deadline)
      abort.abort()
      await session?.release()
      await server.close()
    }
  }, 5000)

  test("optional unusable quota never prevents identity or changes local health", async () => {
    const quotaReplies: Array<FixtureReply> = [
      { kind: "json", body: { unrelated: true } },
      { kind: "failure", status: 503 },
      { kind: "redirect" },
      { kind: "oversize" },
      { kind: "stream-oversize" },
    ]
    for (const reply of quotaReplies) {
      const server = await fixture({ invalidUsage: true })
      server.setReply("/usage", reply)
      let session: Awaited<ReturnType<typeof probeLegacyProxy>> = null
      try {
        session = await probeLegacyProxy({ connection: server.connection })
        expect(session).not.toBeNull()
        if (!session)
          throw new Error("Expected session with unavailable metadata")
        const snapshot = await session.read()
        expect(snapshot.status).toBe("reachable")
        expect(snapshot.catalog).toHaveLength(1)
        expect(snapshot.activity).toHaveLength(1)
        expect(snapshot.usage).toBeNull()
      } finally {
        await session?.release()
        await server.close()
      }
    }
  })

  test("paces background quota by attempt start while explicit reads bypass the cooldown and retain failures", async () => {
    const now = spyOn(Date, "now").mockReturnValue(10_000)
    const server = await fixture({ hangingUsage: true })
    let session: Awaited<ReturnType<typeof probeLegacyProxy>> = null
    try {
      session = await probeLegacyProxy({ connection: server.connection })
      if (!session) throw new Error("Expected session")
      const read = session.read()
      await waitFor(() => server.activeCount("/usage") === 1)
      now.mockReturnValue(30_000)
      server.finishUsage()
      const initial = await read
      expect(initial.usage?.plan).toBe("individual")
      expect(server.count("/usage")).toBe(1)
      let latest = initial
      session.subscribe((snapshot) => {
        latest = snapshot
      })
      now.mockReturnValue(69_999)
      await new Promise((resolve) => setTimeout(resolve, 2100))
      expect(server.count("/usage")).toBe(1)
      server.setReply("/usage", { kind: "failure", status: 503 })
      now.mockReturnValue(70_000)
      await waitFor(() => server.count("/usage") === 2, 2600)
      await waitFor(() => server.activeCount("/usage") === 0)
      const failed = latest
      expect(failed.status).toBe("reachable")
      expect(failed.usage).toEqual(initial.usage)
      now.mockReturnValue(129_999)
      await new Promise((resolve) => setTimeout(resolve, 2100))
      expect(server.count("/usage")).toBe(2)
      server.setReply("/usage", {
        kind: "json",
        body: { ...usage, copilot_plan: "business" },
      })
      const refreshed = await session.read()
      expect(server.count("/usage")).toBe(3)
      expect(refreshed.usage?.plan).toBe("business")
      expect(refreshed.status).toBe("reachable")
    } finally {
      await session?.release()
      await server.close()
      now.mockRestore()
    }
  }, 10_000)
})

describe("legacy local observation retention", () => {
  test("retains valid activity when later debug reads fail and still updates the catalog", async () => {
    const server = await fixture()
    const session = await probeLegacyProxy({ connection: server.connection })
    if (!session) throw new Error("Expected session")
    try {
      const initial = await session.read()
      server.setReply("/debug/requests", {
        kind: "json",
        body: { unrelated: true },
      })
      server.setReply("/models", {
        kind: "json",
        body: { object: "list", data: [{ ...model, id: "new-catalog-model" }] },
      })
      const invalid = await session.read()
      expect(invalid.status).toBe("reachable")
      expect(invalid.catalog[0]?.id).toBe("new-catalog-model")
      expect(invalid.activity).toEqual(initial.activity)
      server.setReply("/debug/requests", { kind: "failure", status: 500 })
      expect((await session.read()).activity).toEqual(initial.activity)
      server.setReply("/debug/requests", {
        kind: "json",
        body: { object: "list", data: [trace("recovered-debug")] },
      })
      expect(
        (await session.read()).activity.map((record) => record.id),
      ).toContain("recovered-debug")
    } finally {
      await session.release()
      await server.close()
    }
  })

  test("essential root, catalog and authentication failure retain validated observations until recovery", async () => {
    const server = await fixture()
    const session = await probeLegacyProxy({ connection: server.connection })
    if (!session) throw new Error("Expected session")
    try {
      const initial = await session.read()
      await new Promise((resolve) => setTimeout(resolve, 10))
      server.setReply("/usage", { kind: "failure", status: 503 })
      const failures: Array<{ path: string; reply: FixtureReply }> = [
        { path: "/", reply: { kind: "text", body: "Hello" } },
        {
          path: "/models",
          reply: {
            kind: "json",
            body: { object: "list", data: [{ id: "unverified-model" }] },
          },
        },
        { path: "/models", reply: { kind: "failure", status: 401 } },
      ]
      for (const failure of failures) {
        server.setReply(failure.path, failure.reply)
        const failed = await session.read()
        expect(failed.status).toBe("unreachable")
        expect(failed.observedAt).toBe(initial.observedAt)
        expect(failed.catalog).toEqual(initial.catalog)
        expect(failed.activity).toEqual(initial.activity)
        expect(failed.usage).toEqual(initial.usage)
        server.setReply("/", { kind: "text", body: "Server running" })
        server.setReply("/models", {
          kind: "json",
          body: { object: "list", data: [model] },
        })
      }
      server.replaceHistory([trace("recovered-local")])
      const recovered = await session.read()
      expect(recovered.status).toBe("reachable")
      expect(recovered.activity.map((record) => record.id)).toContain(
        "recovered-local",
      )
    } finally {
      await session.release()
      await server.close()
    }
  })
})

describe("legacy observer job lifecycle", () => {
  test("coalesces overlapping local and quota reads without delaying independent publication", async () => {
    const server = await fixture({ hangingUsage: true })
    const session = await probeLegacyProxy({ connection: server.connection })
    if (!session) throw new Error("Expected local session")
    try {
      server.setReply("/models", { kind: "hang" })
      const snapshots: Array<string> = []
      session.subscribe((snapshot) => snapshots.push(snapshot.status))
      const reads = [session.read(), session.read(), session.read()]
      await waitFor(
        () =>
          server.activeCount("/models") === 1
          && server.activeCount("/usage") === 1,
      )
      expect(server.count("/")).toBe(2)
      expect(server.count("/models")).toBe(2)
      expect(server.count("/debug/requests")).toBe(2)
      expect(server.count("/usage")).toBe(1)
      server.finish("/models", { object: "list", data: [model] })
      await waitFor(() => snapshots.length === 2)
      expect(snapshots).toEqual(["reachable", "reachable"])
      server.finishUsage()
      for (const snapshot of await Promise.all(reads)) {
        expect(snapshot.status).toBe("reachable")
        expect(snapshot.usage?.plan).toBe("individual")
      }
      expect(server.count("/usage")).toBe(1)
    } finally {
      await session.release()
      await server.close()
    }
  })

  test("late quota merges into current local state without reviving unreachable status or losing activity", async () => {
    const server = await fixture()
    const now = spyOn(Date, "now").mockReturnValue(10_000)
    const session = await probeLegacyProxy({ connection: server.connection })
    if (!session) throw new Error("Expected session")
    try {
      await session.read()
      server.setReply("/usage", { kind: "hang" })
      now.mockReturnValue(70_000)
      const dueRead = session.read()
      await waitFor(() => server.activeCount("/usage") === 1)
      const snapshots: Array<Awaited<ReturnType<typeof session.read>>> = []
      session.subscribe((snapshot) => snapshots.push(snapshot))
      server.replaceHistory([trace("newer-local")])
      const newerRead = session.read()
      await waitFor(() =>
        snapshots.some((snapshot) =>
          snapshot.activity.some((record) => record.id === "newer-local"),
        ),
      )
      server.setReply("/", { kind: "failure", status: 503 })
      const failedRead = session.read()
      await waitFor(() => snapshots.at(-1)?.status === "unreachable")
      const observedAt = snapshots.at(-1)?.observedAt
      now.mockReturnValue(129_999)
      server.finishUsage({ ...usage, copilot_plan: "business" })
      await Promise.all([dueRead, newerRead, failedRead])
      const latest = snapshots.at(-1)
      expect(latest?.status).toBe("unreachable")
      expect(latest?.observedAt).toBe(observedAt)
      expect(latest?.activity.map((record) => record.id)).toContain(
        "newer-local",
      )
      expect(latest?.usage?.plan).toBe("business")
      expect(server.count("/usage")).toBe(2)
      server.setReply("/usage", { kind: "json", body: usage })
      now.mockReturnValue(130_000)
      await session.read()
      expect(server.count("/usage")).toBe(3)
    } finally {
      await session.release()
      await server.close()
      now.mockRestore()
    }
  }, 5000)

  test("release aborts both jobs, awaits their cleanup and prevents later notifications", async () => {
    const server = await fixture({ hangingUsage: true })
    const abort = new AbortController()
    const deadline = setTimeout(() => abort.abort(), 600)
    let session: Awaited<ReturnType<typeof probeLegacyProxy>> = null
    try {
      session = await probeLegacyProxy({
        connection: server.connection,
        signal: abort.signal,
      })
      clearTimeout(deadline)
      expect(session).not.toBeNull()
      if (!session) throw new Error("Expected local session")
      const snapshots: Array<string> = []
      session.subscribe((snapshot) => snapshots.push(snapshot.status))
      server.setReply("/models", { kind: "hang" })
      server.setReply("/debug/requests", { kind: "hang" })
      const read = session.read()
      await waitFor(
        () =>
          server.activeCount("/models") === 1
          && server.activeCount("/debug/requests") === 1
          && server.activeCount("/usage") === 1,
      )
      const notifications = snapshots.length
      const releaseStartedAt = performance.now()
      await session.release()
      expect(performance.now() - releaseStartedAt).toBeLessThan(1000)
      await read
      const requests = [
        server.count("/"),
        server.count("/models"),
        server.count("/usage"),
        server.count("/debug/requests"),
      ]
      server.finish("/models", { object: "list", data: [model] })
      server.finish("/debug/requests", {
        object: "list",
        data: [trace("after-release")],
      })
      server.finishUsage()
      await new Promise((resolve) => setTimeout(resolve, 2100))
      expect([
        server.count("/"),
        server.count("/models"),
        server.count("/usage"),
        server.count("/debug/requests"),
      ]).toEqual(requests)
      expect(snapshots).toHaveLength(notifications)
      expect((await session.read()).status).toBe("reachable")
      expect(new Set(server.methods)).toEqual(new Set(["GET"]))
      expect(await (await fetch(server.connection.rootUrl)).text()).toBe(
        "Server running",
      )
    } finally {
      clearTimeout(deadline)
      abort.abort()
      await session?.release()
      await server.close()
    }
  })
})
