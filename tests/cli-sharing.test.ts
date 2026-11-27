import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { once } from "node:events"
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { createConnection, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

import type {
  NativeIntent,
  NativeSessionAuthority,
  NativeSnapshot,
  ServiceSnapshot,
} from "~/lib/proxy-contracts"

import { runAuth } from "~/auth"
import { runCheckUsage } from "~/check-usage"
import { getDebugInfo } from "~/debug"
import { probeLegacyProxy } from "~/lib/legacy-proxy"
import {
  creatorLeaseSchema,
  nativeConnectionSchema,
  nativeSnapshotSchema,
} from "~/lib/proxy-contracts"
import {
  hostProxySession,
  nativeControlCapability,
  observeProxySession,
  writeNativeCredentialProvenance,
} from "~/lib/proxy-session"
import { connectProxyClient } from "~/lib/proxy-session-wire"
import {
  claudeCodeCommand,
  explicitCliRuntime,
  monitorProxySession,
  runStart,
  type RunServerOptions,
} from "~/start"
import { runStop } from "~/stop"

const privateControl = nativeControlCapability()
const it = test.skipIf(privateControl.kind !== "supported")

let directory: string
let release: (() => Promise<void>) | undefined
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "copilot-cli-sharing-"))
})
afterEach(async () => {
  const dispose = release
  release = undefined
  await dispose?.()
  await rm(directory, { recursive: true, force: true })
})
const connection = nativeConnectionSchema.parse({
  rootUrl: "http://localhost:48923/",
  apiUrl: "http://localhost:48923/v1",
  authentication: {
    kind: "keyed",
    key: "fixture-real-key'with$metacharacters",
  },
})
const values: RunServerOptions = {
  port: 4141,
  verbose: false,
  accountType: "individual",
  manual: false,
  rateLimitWait: false,
  claudeCode: false,
  showToken: false,
  proxyEnv: false,
  responsesContextTrim: false,
}
const model = {
  id: "claude-sonnet-5.5",
  name: "Claude Sonnet",
  vendor: "Anthropic",
  preview: false,
  contextWindow: 200000,
  maxOutput: 64000,
  supports: [],
  endpoints: ["/responses", "/chat/completions"],
}

function roots() {
  return { homeDirectory: directory, stateDirectory: join(directory, "native") }
}

async function owner(platform?: NodeJS.Platform) {
  let snapshot = nativeSnapshotSchema.parse({
    kind: "managed",
    sessionId: "cli-shared-owner",
    gatewayGeneration: 7,
    revision: 1,
    account: {
      kind: "signed-in",
      login: "existing-native-user",
      name: null,
      plan: "fixture-plan",
      credentialSource: "native-vault",
      epoch: 2,
    },
    authorization: { kind: "idle" },
    storageMode: "encrypted",
    gateway: {
      kind: "running",
      connection: { ...connection, authentication: { kind: "keyed" } },
      startedAt: "2026-10-30T10:00:00.000Z",
    },
    options: {
      port: 48923,
      accountType: "enterprise",
      manualApprove: true,
      rateLimitSeconds: 4,
      rateLimitWait: true,
      responsesContextTrim: false,
      proxyFromEnvironment: false,
    },
    authentication: { kind: "keyed" },
    capabilities: {
      kind: "managed",
      runtime: "managed",
      account: "managed",
      activity: "completed",
      drain: true,
    },
    catalog: [model],
    usage: {
      plan: "owner-quota",
      resetAt: "2026-11-01",
      fetchedAt: "2026-10-30T10:00:00.000Z",
      quotas: [{ kind: "unlimited", id: "chat", label: "Chat" }],
    },
    activity: [],
    totals: {
      requests: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
    },
  })
  const listeners = new Set<(snapshot: ServiceSnapshot) => void>()
  const commands: Array<NativeIntent> = []
  const publish = (next: NativeSnapshot) => {
    snapshot = next
    for (const listener of listeners) listener(next)
  }
  const api: NativeSessionAuthority = {
    snapshot: () => snapshot,
    connection: () => connection,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async dispatch(intent) {
      await Promise.resolve()
      commands.push(intent)
      if (intent.kind === "authorize") {
        publish(
          nativeSnapshotSchema.parse({
            ...snapshot,
            authorization: { kind: "connecting", id: "fixture-auth-request" },
          }),
        )
        setTimeout(() => {
          publish(
            nativeSnapshotSchema.parse({
              ...snapshot,
              account: {
                ...snapshot.account,
                kind: "signed-in",
                login: "replacement-native-user",
                name: null,
                plan: "fixture-plan",
                credentialSource: "native-vault",
                epoch: 3,
              },
              authorization: { kind: "idle" },
            }),
          )
        }, 30)
      }
      if (intent.kind === "stop-gateway") {
        if (
          intent.expected.sessionId !== snapshot.sessionId
          || intent.expected.gatewayGeneration !== snapshot.gatewayGeneration
        )
          return { kind: "session-changed", snapshot }
        publish(
          nativeSnapshotSchema.parse({
            ...snapshot,
            gateway: { kind: "stopped" },
          }),
        )
      }
      return { kind: "applied", snapshot, createdGateway: null }
    },
  }
  const dispose = await hostProxySession(
    { ...roots(), authority: api, showUi: () => {} },
    { platform },
  )
  release = dispose
  return { commands, snapshot: () => snapshot }
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2000
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10))
  expect(predicate()).toBe(true)
}

describe("CLI shares the native authority", () => {
  test("Start help exposes explicit shared and standalone modes", () => {
    const child = Bun.spawnSync([
      process.execPath,
      fileURLToPath(new URL("../src/main.ts", import.meta.url)),
      "start",
      "--help",
    ])
    expect(child.exitCode).toBe(0)
    expect(child.stdout.toString()).toContain("--shared")
    expect(child.stdout.toString()).toContain("--standalone")
  })

  test("default Start stays standalone and rejects a private profile before contacting its native owner", async () => {
    const shared = await owner()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 100)
    try {
      await runStart({
        ...roots(),
        values,
        explicit: {},
        signal: controller.signal,
      }).then(
        () => {
          throw new Error("Expected standalone profile rejection")
        },
        (error: unknown) => {
          expect(error instanceof Error && error.message).toContain(
            "Standalone CLI authentication uses the standard user home.",
          )
        },
      )
      expect(shared.commands).toEqual([])
    } finally {
      clearTimeout(timer)
    }
  })

  it("shared Start attaches without resetting enterprise options, then recognizes Stop from another client", async () => {
    const shared = await owner()
    const sharedValues = { ...values, shared: true }
    const pending = runStart({
      ...roots(),
      values: sharedValues,
      explicit: explicitCliRuntime({
        values: sharedValues,
        rawArgs: ["--shared"],
      }),
    })
    await waitFor(() =>
      shared.commands.some((intent) => intent.kind === "ensure-running"),
    )
    expect(
      shared.commands.find((intent) => intent.kind === "ensure-running"),
    ).toMatchObject({
      explicit: {},
      credential: { kind: "native-saved-account" },
    })
    expect(shared.snapshot().options).toMatchObject({
      port: 48923,
      accountType: "enterprise",
      manualApprove: true,
      rateLimitSeconds: 4,
      rateLimitWait: true,
    })
    await runStop(roots())
    await pending
    expect(
      shared.commands.filter((intent) => intent.kind === "stop-gateway"),
    ).toEqual([
      {
        kind: "stop-gateway",
        expected: creatorLeaseSchema.parse({
          sessionId: "cli-shared-owner",
          gatewayGeneration: 7,
        }),
        timeoutMs: 15000,
      },
    ])
    await runStop(roots())
    expect(
      shared.commands.filter((intent) => intent.kind === "stop-gateway"),
    ).toHaveLength(1)
  })

  it("shared Auth, quota and Debug use the native account while preserving old plaintext credentials", async () => {
    const shared = await owner()
    const oldPath = join(
      directory,
      ".local",
      "share",
      "copilot-proxy-api",
      "github_token",
    )
    await mkdir(join(directory, ".local", "share", "copilot-proxy-api"), {
      recursive: true,
    })
    await writeFile(oldPath, "fixture-old-account-token")
    const authOpts = {
      ...roots(),
      shared: true,
      verbose: false,
      showToken: false,
    }
    await runAuth(authOpts)
    expect(
      shared.commands.filter((intent) => intent.kind === "authorize"),
    ).toHaveLength(1)
    expect(
      shared.commands.filter((intent) => intent.kind === "show-ui"),
    ).toHaveLength(1)
    await runCheckUsage({ ...roots(), shared: true })
    expect(
      shared.commands.filter((intent) => intent.kind === "refresh"),
    ).toHaveLength(1)
    const debug = await getDebugInfo(roots())
    expect(debug.proxy).toMatchObject({
      kind: "managed",
      accountLogin: "replacement-native-user",
      credentialStorage: "encrypted",
      models: 1,
    })
    expect(JSON.stringify(debug)).not.toContain(
      connection.authentication.kind === "keyed" ?
        connection.authentication.key
      : "unused",
    )
    expect(await readFile(oldPath, "utf8")).toBe("fixture-old-account-token")
  })

  test("native sign-out prevents shared Start and Auth from resurrecting preserved standalone credentials", async () => {
    await writeNativeCredentialProvenance({
      ...roots(),
      provenance: { kind: "native-authority", account: "signed-out" },
    })
    const expected =
      privateControl.kind === "unsupported" ?
        privateControl.message
      : "native Copilot Proxy storage"
    const sharedStart = {
      ...roots(),
      values: { ...values, shared: true },
      explicit: {},
    }
    for (const run of [
      runStart(sharedStart),
      runAuth({ ...roots(), shared: true, verbose: false, showToken: false }),
    ]) {
      await run.then(
        () => {
          throw new Error("Expected native-storage rejection")
        },
        (error: unknown) => {
          expect(error instanceof Error && error.message).toContain(expected)
        },
      )
    }
  })
})

test("runtime overrides include only explicitly supplied flags and their actual boolean/auth values", () => {
  expect(
    explicitCliRuntime({
      values: { ...values, rateLimit: 10, apiKey: "old-default" },
      rawArgs: ["--verbose"],
    }),
  ).toEqual({})
  expect(
    explicitCliRuntime({
      values: {
        ...values,
        port: 48925,
        manual: false,
        apiKey: "actual-one,actual-two",
      },
      rawArgs: [
        "--port=48925",
        "--no-manual",
        "--api-key",
        "actual-one,actual-two",
      ],
    }),
  ).toEqual({
    port: 48925,
    manualApprove: false,
    authentication: { kind: "keyed", keys: ["actual-one", "actual-two"] },
  })
  expect(
    explicitCliRuntime({
      values: { ...values, port: 48925, rateLimitWait: true },
      rawArgs: ["-p48925", "-w"],
    }),
  ).toEqual({ port: 48925, rateLimitWait: true })
  expect(explicitCliRuntime({ values, rawArgs: ["--api-key", ""] })).toEqual({
    authentication: { kind: "none" },
  })
  expect(explicitCliRuntime({ values, rawArgs: ["--standalone"] })).toEqual({})
  expect(
    explicitCliRuntime({
      values: { ...values, verbose: true, rateLimitWait: true },
      rawArgs: ["-vw"],
    }),
  ).toEqual({ rateLimitWait: true })
  expect(
    explicitCliRuntime({
      values: { ...values, githubToken: "--manual" },
      rawArgs: ["--github-token", "--manual"],
    }),
  ).toEqual({})
})

test.each(["win32", "linux"] as const)(
  "%s unavailable marker rejects Start and Auth without using preserved standalone credentials",
  async (platform) => {
    const capability = nativeControlCapability({ platform })
    if (capability.kind !== "unsupported")
      throw new Error("Expected unsupported host")
    const shared = await owner(platform)
    const oldDirectory = join(directory, ".local", "share", "copilot-proxy-api")
    const oldPath = join(oldDirectory, "github_token")
    await mkdir(oldDirectory, { recursive: true })
    await writeFile(oldPath, "fixture-old-account-token")
    const results = await Promise.allSettled([
      runStart({
        ...roots(),
        values: { ...values, shared: true },
        explicit: {},
      }),
      runAuth({ ...roots(), shared: true, verbose: false, showToken: false }),
    ])
    for (const result of results)
      expect(result).toMatchObject({
        status: "rejected",
        reason: { message: capability.message },
      })
    expect(shared.commands).toEqual([])
    expect(await readFile(oldPath, "utf8")).toBe("fixture-old-account-token")
  },
)

describe("Claude instructions reflect saved config and actual auth", () => {
  test("a ready existing config uses its exact alias and keeps the small model independently configured", async () => {
    await mkdir(join(directory, ".claude"))
    const text = JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: connection.rootUrl,
        ANTHROPIC_AUTH_TOKEN:
          connection.authentication.kind === "keyed" ?
            connection.authentication.key
          : "",
        ANTHROPIC_MODEL: "claude-sonnet-5.5[1m]",
        ANTHROPIC_SMALL_FAST_MODEL: "claude-sonnet-5",
      },
      hooks: { existing: true },
    })
    const filename = join(directory, ".claude", "settings.json")
    await writeFile(filename, text)
    expect(
      await claudeCodeCommand({
        homeDirectory: directory,
        connection,
        catalog: [model],
        selectModel: () => {
          throw new Error("A configured model must not prompt")
        },
      }),
    ).toBe("claude")
    expect(await readFile(filename, "utf8")).toBe(text)
  })

  test("a keyed override uses the actual port/key and exact alias without replacing existing settings", async () => {
    await mkdir(join(directory, ".claude"))
    const text = JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "http://localhost:4141/",
        ANTHROPIC_AUTH_TOKEN: "fixture-old-key",
        ANTHROPIC_MODEL: "claude-sonnet-5.5[1m]",
        ANTHROPIC_SMALL_FAST_MODEL: "claude-sonnet-5",
      },
    })
    const filename = join(directory, ".claude", "settings.json")
    await writeFile(filename, text)
    const generated = await claudeCodeCommand({
      homeDirectory: directory,
      connection,
      catalog: [model],
    })
    const command =
      generated.startsWith("powershell.exe -NoProfile -EncodedCommand ") ?
        Buffer.from(generated.split(" ").at(-1) ?? "", "base64").toString(
          "utf16le",
        )
      : generated
    if (process.platform === "win32") {
      expect(command).toContain(
        "$env:ANTHROPIC_BASE_URL = 'http://localhost:48923/'",
      )
      expect(command).toContain(
        "$env:ANTHROPIC_AUTH_TOKEN = 'fixture-real-key''with$metacharacters'",
      )
      expect(command).toContain(
        "$env:ANTHROPIC_MODEL = 'claude-sonnet-5.5[1m]'",
      )
      expect(command.endsWith("; claude")).toBe(true)
    } else {
      expect(command).toContain("ANTHROPIC_BASE_URL='http://localhost:48923/'")
      expect(command).toContain(
        String.raw`ANTHROPIC_AUTH_TOKEN='fixture-real-key'\''with$metacharacters'`,
      )
      expect(command).toContain("ANTHROPIC_MODEL='claude-sonnet-5.5[1m]'")
    }
    expect(command).not.toContain("ANTHROPIC_SMALL_FAST_MODEL")
    expect(command).not.toContain("dummy")
    expect(await readFile(filename, "utf8")).toBe(text)
  })

  test("an unkeyed connection adds no invented auth value", async () => {
    const unkeyed = nativeConnectionSchema.parse({
      ...connection,
      authentication: { kind: "none" },
    })
    const generated = await claudeCodeCommand({
      homeDirectory: directory,
      connection: unkeyed,
      catalog: [model],
      selectModel: () => Promise.resolve(model.id),
    })
    const command =
      generated.startsWith("powershell.exe -NoProfile -EncodedCommand ") ?
        Buffer.from(generated.split(" ").at(-1) ?? "", "base64").toString(
          "utf16le",
        )
      : generated
    expect(command).not.toContain("ANTHROPIC_AUTH_TOKEN")
    expect(command).not.toContain("dummy")
    expect(command).toContain(
      process.platform === "win32" ?
        "$env:ANTHROPIC_MODEL = 'claude-sonnet-5.5'"
      : "ANTHROPIC_MODEL='claude-sonnet-5.5'",
    )
  })
})

describe("monitorProxySession throttling", () => {
  test("monitoring a legacy session does not hammer /usage across 2s polls", async () => {
    let usageRequests = 0
    let modelsRequests = 0
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        switch (new URL(request.url).pathname) {
          case "/": {
            return new Response("Server running")
          }
          case "/models": {
            modelsRequests++
            return Response.json({ object: "list", data: [] })
          }
          case "/debug/requests": {
            return Response.json({ object: "list", data: [] })
          }
          case "/usage": {
            usageRequests++
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
    const legacyConnection = nativeConnectionSchema.parse({
      rootUrl,
      apiUrl: `${rootUrl}/v1`,
      authentication: { kind: "none" },
    })
    const session = await probeLegacyProxy({ connection: legacyConnection })
    if (!session) throw new Error("Expected legacy session")
    const abort = new AbortController()
    try {
      const monitoring = monitorProxySession({ session, signal: abort.signal })
      await new Promise((resolve) => setTimeout(resolve, 2300))
      abort.abort()
      await monitoring
      expect(modelsRequests).toBeGreaterThanOrEqual(2)
      expect(usageRequests).toBe(1)
    } finally {
      await session.release()
      await server.stop(true)
    }
  }, 5000)
})

describe("private control wire hardening", () => {
  it("wire protocol sends one initial snapshot for synchronous authorities, avoids listener leaks on throw, and halts frames on destroy", async () => {
    let snapshot: NativeSnapshot = nativeSnapshotSchema.parse({
      kind: "managed",
      sessionId: "wire-hardening-owner",
      gatewayGeneration: 1,
      revision: 0,
      account: {
        kind: "signed-in",
        login: "wire-user",
        name: null,
        plan: "individual",
        credentialSource: "native-vault",
        epoch: 1,
      },
      authorization: { kind: "idle" },
      storageMode: "encrypted",
      gateway: { kind: "stopped" },
      capabilities: {
        kind: "managed",
        runtime: "managed",
        account: "managed",
        activity: "completed",
        drain: true,
      },
      options: {
        port: 48923,
        accountType: "individual",
        manualApprove: false,
        rateLimitSeconds: null,
        rateLimitWait: false,
        responsesContextTrim: false,
        proxyFromEnvironment: false,
      },
      authentication: { kind: "keyed" },
      catalog: [],
      usage: null,
      activity: [],
      totals: {
        requests: 0,
        errors: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
      },
    })
    const listeners = new Set<(next: ServiceSnapshot) => void>()
    const commands: Array<NativeIntent> = []
    let failNextInitial = false
    const syncAuthority: NativeSessionAuthority = {
      snapshot: () => snapshot,
      connection: () => connection,
      subscribe(listener) {
        listeners.add(listener)
        if (failNextInitial) {
          failNextInitial = false
          listener({ invalid: true } as unknown as ServiceSnapshot)
        } else {
          listener(snapshot)
        }
        return () => {
          listeners.delete(listener)
        }
      },
      dispatch(intent) {
        commands.push(intent)
        return Promise.resolve({
          kind: "applied",
          snapshot,
          createdGateway: null,
        })
      },
    }
    release = await hostProxySession({
      ...roots(),
      authority: syncAuthority,
      showUi: () => {},
    })

    const session = await observeProxySession({
      ...roots(),
      discovery: { configuredAgents: [], savedRuntime: snapshot.options },
    })
    expect(session.kind).toBe("managed")
    if (session.kind !== "managed") throw new Error("Expected managed session")
    const received: Array<number> = []
    const unsubscribe = session.subscribe((next) => {
      if (next.kind === "managed") received.push(next.revision)
    })
    await waitFor(() => received.length > 0)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(received).toEqual([0])

    snapshot = nativeSnapshotSchema.parse({ ...snapshot, revision: 1 })
    for (const listener of listeners) listener(snapshot)
    await waitFor(() => received.includes(1))
    expect(received).toEqual([0, 1])
    unsubscribe()
    await session.release()
    await waitFor(() => listeners.size === 0)

    const sessionsDir = join(roots().stateDirectory, "sessions")
    const [publisher] = await readdir(sessionsDir)
    if (!publisher) throw new Error("Expected publisher")
    const live = z
      .object({
        publisherId: z.string(),
        nonce: z.string(),
        socketPath: z.string(),
      })
      .parse(
        JSON.parse(
          await readFile(join(sessionsDir, publisher, "control.json"), "utf8"),
        ),
      )

    failNextInitial = true
    const badSubscribeSocket = createConnection(live.socketPath)
    badSubscribeSocket.on("error", () => {})
    await once(badSubscribeSocket, "connect")
    const responses: Array<string> = []
    badSubscribeSocket.on("data", (chunk) =>
      responses.push(chunk.toString("utf8")),
    )
    badSubscribeSocket.write(
      JSON.stringify({
        protocol: 1,
        id: "sub-fail",
        publisherId: live.publisherId,
        nonce: live.nonce,
        command: { kind: "subscribe" },
      }) + "\n",
    )
    await waitFor(() => responses.join("").includes('"kind":"error"'))
    expect(listeners.size).toBe(0)
    badSubscribeSocket.destroy()

    const pipelined = createConnection(live.socketPath)
    pipelined.on("error", () => {})
    await once(pipelined, "connect")
    const closed = once(pipelined, "close")
    const badNonce = JSON.stringify({
      protocol: 1,
      id: "bad-first",
      publisherId: live.publisherId,
      nonce: "0".repeat(64),
      command: { kind: "read" },
    })
    const validFollowup = JSON.stringify({
      protocol: 1,
      id: "valid-second",
      publisherId: live.publisherId,
      nonce: live.nonce,
      command: { kind: "invoke", intent: { kind: "sign-out" } },
    })
    pipelined.write(`${badNonce}\n${validFollowup}\n`)
    await closed
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(commands).toHaveLength(0)

    const slowSocket = join(directory, "slow-read.sock")
    const slowServer = createServer((socket) => {
      let buf = ""
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf8")
        if (!buf.includes("\n")) return
        const req = z.object({ id: z.string() }).parse(JSON.parse(buf.trim()))
        setTimeout(() => {
          if (socket.destroyed) return
          socket.write(
            JSON.stringify({
              protocol: 1,
              id: req.id,
              publisherId: live.publisherId,
              nonce: live.nonce,
              result: { kind: "snapshot", snapshot },
            }) + "\n",
          )
        }, 2200)
      })
    })
    await new Promise<void>((resolve, reject) => {
      slowServer.once("error", reject).listen(slowSocket, () => resolve())
    })
    const slowClient = connectProxyClient({
      publisherId: live.publisherId,
      nonce: live.nonce,
      socketPath: slowSocket,
    })
    try {
      expect(await slowClient.read()).toEqual(snapshot)
    } finally {
      await slowClient.release()
      await new Promise<void>((resolve) => slowServer.close(() => resolve()))
    }
  }, 5000)
})
