import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import type {
  NativeIntent,
  NativeSessionAuthority,
  OpenProxySessionOptions,
  ServiceSnapshot,
} from "~/lib/proxy-contracts"

import { runAuth } from "~/auth"
import { runCheckUsage } from "~/check-usage"
import {
  creatorLeaseSchema,
  legacySnapshotSchema,
  nativeConnectionSchema,
  nativeSnapshotSchema,
  runtimeOptionsSchema,
} from "~/lib/proxy-contracts"
import {
  hostProxySession,
  nativeControlCapability,
  observeProxySession,
  openProxySession,
  writeNativeCredentialProvenance,
} from "~/lib/proxy-session"
import { explicitCliRuntime, runStart, type RunServerOptions } from "~/start"

const privateControl = nativeControlCapability()
const it = test.skipIf(privateControl.kind !== "supported")
const mainEntry = fileURLToPath(new URL("../src/main.ts", import.meta.url))

const runtime = runtimeOptionsSchema.parse({
  port: 48921,
  accountType: "individual",
  manualApprove: false,
  rateLimitSeconds: null,
  rateLimitWait: false,
  responsesContextTrim: false,
  proxyFromEnvironment: false,
})
const connection = nativeConnectionSchema.parse({
  rootUrl: "http://localhost:48921/",
  apiUrl: "http://localhost:48921/v1",
  authentication: { kind: "keyed", key: "fixture-native-api-key" },
})
const baseValues: RunServerOptions = {
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

const noopUnsubscribe = () => {}
const noopShowUi = () => {}

function makeManagedSnapshot(overrides?: {
  account?: { kind: "signed-out" }
  gateway?: { kind: "stopped" }
}) {
  return nativeSnapshotSchema.parse({
    kind: "managed",
    sessionId: "standalone-recovery-owner",
    gatewayGeneration: 2,
    revision: 1,
    account: overrides?.account ?? {
      kind: "signed-in",
      login: "recovered-user",
      name: null,
      plan: "individual",
      credentialSource: "native-vault",
      epoch: 1,
    },
    authorization: { kind: "idle" },
    storageMode: "encrypted",
    gateway: overrides?.gateway ?? {
      kind: "running",
      connection: { ...connection, authentication: { kind: "keyed" } },
      startedAt: "2026-10-30T10:00:00.000Z",
    },
    capabilities: {
      kind: "managed",
      runtime: "managed",
      account: "managed",
      activity: "completed",
      drain: true,
    },
    options: runtime,
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
}

function makeLegacySnapshot(status: "reachable" | "unreachable") {
  return legacySnapshotSchema.parse({
    kind: "legacy",
    connection: { ...connection, authentication: { kind: "none" } },
    status,
    account: { kind: "external-unverified" },
    capabilities: {
      kind: "legacy",
      runtime: "read-only",
      account: "unverified",
      activity: "observed",
      drain: false,
    },
    catalog: [],
    usage: null,
    activity: [],
    observedAt: "2026-10-30T10:00:00.000Z",
    totals: {
      requests: null,
      errors: null,
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
    },
  })
}

let directory = ""
const disposals: Array<() => Promise<void>> = []

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "copilot-cli-standalone-"))
})

afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose()
  await rm(directory, { recursive: true, force: true })
})

function roots() {
  return {
    homeDirectory: directory,
    stateDirectory: join(directory, "native"),
  }
}

function sessionOptions(): OpenProxySessionOptions {
  return {
    ...roots(),
    discovery: { configuredAgents: [], savedRuntime: runtime },
    intent: {
      kind: "ensure-running",
      explicit: {},
      credential: { kind: "native-saved-account" },
    },
  }
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2000
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10))
  expect(predicate()).toBe(true)
}

describe("CLI standalone default", () => {
  test("start, auth, and check-usage help expose opt-in --shared without leaking into runtime overrides", () => {
    for (const command of ["start", "auth", "check-usage"]) {
      const child = Bun.spawnSync([
        process.execPath,
        mainEntry,
        command,
        "--help",
      ])
      expect(child.exitCode).toBe(0)
      expect(child.stdout.toString()).toContain("--shared")
    }
    expect(
      explicitCliRuntime({
        values: { ...baseValues, shared: true },
        rawArgs: ["--shared"],
      }),
    ).toEqual({})
  })

  it("default start, auth, and check-usage stay standalone even when a native host holds an unreachable legacy session", async () => {
    const commands: Array<NativeIntent> = []
    const deadLegacy = makeLegacySnapshot("unreachable")
    const api: NativeSessionAuthority = {
      snapshot: () => deadLegacy,
      connection: () => null,
      subscribe: () => noopUnsubscribe,
      dispatch(intent) {
        commands.push(intent)
        return Promise.resolve({
          kind: "session-changed",
          snapshot: deadLegacy,
        })
      },
    }
    disposals.push(
      await hostProxySession({
        stateDirectory: roots().stateDirectory,
        authority: api,
        showUi: noopShowUi,
      }),
    )
    await writeNativeCredentialProvenance({
      stateDirectory: roots().stateDirectory,
      provenance: { kind: "native-authority", account: "signed-out" },
    })

    const results = await Promise.allSettled([
      runStart({ ...roots(), values: baseValues, explicit: {} }),
      runAuth({ ...roots(), verbose: false, showToken: false }),
      runCheckUsage(roots()),
    ])
    for (const result of results) {
      expect(result).toMatchObject({
        status: "rejected",
        reason: {
          message:
            "The selected native profile has no available authority. Standalone CLI authentication uses the standard user home.",
        },
      })
    }
    expect(commands).toEqual([])
  })
})

describe("opt-in shared legacy recovery and fallback", () => {
  it("shared Start recovers cleanly when the native broker holds an unreachable legacy attachment", async () => {
    const managed = makeManagedSnapshot()
    let current: ServiceSnapshot = makeLegacySnapshot("unreachable")
    const listeners = new Set<(snapshot: ServiceSnapshot) => void>()
    const commands: Array<NativeIntent> = []
    const publish = (next: ServiceSnapshot) => {
      current = next
      for (const listener of listeners) listener(next)
    }
    const api: NativeSessionAuthority = {
      snapshot: () => current,
      connection: () => connection,
      subscribe(listener) {
        listeners.add(listener)
        listener(current)
        return () => {
          listeners.delete(listener)
        }
      },
      async dispatch(intent) {
        await Promise.resolve()
        commands.push(intent)
        if (intent.kind === "ensure-running") {
          publish(managed)
          return {
            kind: "applied",
            snapshot: managed,
            createdGateway: creatorLeaseSchema.parse({
              sessionId: managed.sessionId,
              gatewayGeneration: managed.gatewayGeneration,
            }),
          }
        }
        if (intent.kind === "stop-gateway") {
          const stopped = nativeSnapshotSchema.parse({
            ...managed,
            gateway: { kind: "stopped" },
          })
          publish(stopped)
          return { kind: "applied", snapshot: stopped, createdGateway: null }
        }
        return { kind: "session-changed", snapshot: current }
      },
    }
    disposals.push(
      await hostProxySession({
        stateDirectory: roots().stateDirectory,
        authority: api,
        showUi: noopShowUi,
      }),
    )
    const abort = new AbortController()
    const pending = runStart({
      ...roots(),
      values: { ...baseValues, shared: true },
      explicit: {},
      signal: abort.signal,
    })
    await waitFor(() =>
      commands.some((intent) => intent.kind === "ensure-running"),
    )
    abort.abort()
    await pending
    expect(commands.map((intent) => intent.kind)).toEqual([
      "ensure-running",
      "stop-gateway",
    ])
  })

  it("refreshes a stale reachable legacy snapshot from an older broker before attaching", async () => {
    let current: ServiceSnapshot = makeLegacySnapshot("reachable")
    const commands: Array<NativeIntent> = []
    const api: NativeSessionAuthority = {
      snapshot: () => current,
      connection: () => null,
      subscribe: () => noopUnsubscribe,
      dispatch(intent) {
        commands.push(intent)
        if (intent.kind === "refresh")
          current = makeLegacySnapshot("unreachable")
        return Promise.resolve({ kind: "session-changed", snapshot: current })
      },
    }
    disposals.push(
      await hostProxySession({
        stateDirectory: roots().stateDirectory,
        authority: api,
        showUi: noopShowUi,
      }),
    )
    const result = await openProxySession(sessionOptions())
    expect(result.kind).toBe("unavailable")
    if (result.kind === "unavailable")
      expect(result.message).toContain("no longer reachable")
    expect(commands.map((command) => command.kind)).toEqual([
      "ensure-running",
      "refresh",
    ])
  })

  it("falls back to standalone when an unsigned-in desktop app has no credential provenance, while blocking after sign-out", async () => {
    const signedOut = makeManagedSnapshot({
      account: { kind: "signed-out" },
      gateway: { kind: "stopped" },
    })
    const commands: Array<NativeIntent> = []
    const api: NativeSessionAuthority = {
      snapshot: () => signedOut,
      connection: () => null,
      subscribe: () => noopUnsubscribe,
      dispatch(intent) {
        commands.push(intent)
        return Promise.resolve({
          kind: "unavailable",
          message:
            "Sign in to GitHub in Copilot Proxy before starting a shared gateway.",
        })
      },
    }
    disposals.push(
      await hostProxySession({
        stateDirectory: roots().stateDirectory,
        authority: api,
        showUi: noopShowUi,
      }),
    )
    expect((await openProxySession(sessionOptions())).kind).toBe("standalone")
    expect(commands.at(-1)?.kind).toBe("ensure-running")

    await writeNativeCredentialProvenance({
      stateDirectory: roots().stateDirectory,
      provenance: { kind: "native-authority", account: "signed-out" },
    })
    expect((await openProxySession(sessionOptions())).kind).toBe("unavailable")
  })

  it("connects to an active native session even when an older installation.json points to a missing package", async () => {
    const managed = makeManagedSnapshot()
    const api: NativeSessionAuthority = {
      snapshot: () => managed,
      connection: () => connection,
      subscribe: () => noopUnsubscribe,
      dispatch: () =>
        Promise.resolve({
          kind: "applied",
          snapshot: managed,
          createdGateway: null,
        }),
    }
    disposals.push(
      await hostProxySession({
        stateDirectory: roots().stateDirectory,
        authority: api,
        showUi: noopShowUi,
      }),
    )
    await writeFile(
      join(roots().stateDirectory, "installation.json"),
      JSON.stringify({
        kind: "copilot-proxy-native-installation",
        protocol: 1,
        executablePath: join(
          directory,
          "Deleted.app/Contents/MacOS/Copilot Proxy",
        ),
        packageFingerprint: "a".repeat(64),
      }),
      { mode: 0o600 },
    )
    const session = await observeProxySession(sessionOptions())
    expect(session.kind).toBe("managed")
    if (session.kind === "managed") await session.release()
  })
})
