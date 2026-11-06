import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { once } from "node:events"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

import type {
  NativeIntent,
  NativeSessionAuthority,
  NativeSnapshot,
  OpenProxySessionOptions,
  ServiceSnapshot,
} from "~/lib/proxy-contracts"

import {
  nativeConnectionSchema,
  legacySnapshotSchema,
  nativeSnapshotSchema,
  runtimeOptionsSchema,
} from "~/lib/proxy-contracts"
import {
  hostProxySession,
  nativePackageFingerprint,
  nativeControlCapability,
  observeProxySession,
  openProxySession,
  writeNativeCredentialProvenance,
} from "~/lib/proxy-session"

let directory: string
const disposals: Array<() => Promise<void>> = []
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "copilot-private-session-"))
})
afterEach(async () => {
  for (const disposal of disposals.splice(0).reverse()) await disposal()
  await rm(directory, { recursive: true, force: true })
})
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

function nativeSnapshot(): NativeSnapshot {
  return nativeSnapshotSchema.parse({
    kind: "managed",
    sessionId: "fixture-native-owner",
    gatewayGeneration: 0,
    revision: 0,
    account: {
      kind: "signed-in",
      login: "fixture-user",
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

function authority() {
  let snapshot: ServiceSnapshot = nativeSnapshot()
  const commands: Array<NativeIntent> = []
  const listeners = new Set<(snapshot: ServiceSnapshot) => void>()
  const replace = (next: ServiceSnapshot) => {
    snapshot = next
    for (const listener of listeners) listener(next)
  }
  const api: NativeSessionAuthority = {
    snapshot: () => snapshot,
    connection: () =>
      snapshot.kind === "legacy" ?
        nativeConnectionSchema.parse(snapshot.connection)
      : connection,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async dispatch(intent) {
      await Promise.resolve()
      commands.push(intent)
      if (snapshot.kind !== "managed")
        return { kind: "session-changed", snapshot }
      if (intent.kind === "ensure-running") {
        const created = snapshot.gateway.kind !== "running"
        replace(
          nativeSnapshotSchema.parse({
            ...snapshot,
            gatewayGeneration: snapshot.gatewayGeneration + (created ? 1 : 0),
            revision: snapshot.revision + 1,
            options: {
              ...snapshot.options,
              ...Object.fromEntries(
                Object.entries(intent.explicit).filter(
                  ([key]) => key !== "authentication",
                ),
              ),
            },
            gateway: {
              kind: "running",
              connection: { ...connection, authentication: { kind: "keyed" } },
              startedAt: "2026-10-30T12:00:00.000Z",
            },
          }),
        )
        return {
          kind: "applied",
          snapshot,
          createdGateway:
            created ?
              {
                sessionId: snapshot.sessionId,
                gatewayGeneration: snapshot.gatewayGeneration,
              }
            : null,
        }
      }
      if (intent.kind === "stop-gateway" || intent.kind === "drain-gateway") {
        if (
          intent.expected.sessionId !== snapshot.sessionId
          || intent.expected.gatewayGeneration !== snapshot.gatewayGeneration
        )
          return { kind: "session-changed", snapshot }
        replace(
          nativeSnapshotSchema.parse({
            ...snapshot,
            revision: snapshot.revision + 1,
            gateway: { kind: "stopped" },
          }),
        )
      }
      return { kind: "applied", snapshot, createdGateway: null }
    },
  }
  return { api, commands, replace, snapshot: () => snapshot }
}

function options(
  explicit: OpenProxySessionOptions["intent"]["explicit"] = {},
): OpenProxySessionOptions {
  return {
    homeDirectory: directory,
    stateDirectory: join(directory, "native"),
    discovery: { configuredAgents: [], savedRuntime: runtime },
    intent: {
      kind: "ensure-running",
      explicit,
      credential: { kind: "native-saved-account" },
    },
  }
}

async function hosted() {
  const owner = authority()
  const dispose = await hostProxySession({
    stateDirectory: options().stateDirectory,
    authority: owner.api,
    showUi: () => {},
  })
  disposals.push(dispose)
  return owner
}

async function record() {
  const sessions = join(options().stateDirectory, "sessions")
  const publisher = (await readdir(sessions))[0]
  if (!publisher) throw new Error("Expected publisher")
  return z
    .object({
      publisherId: z.string(),
      nonce: z.string(),
      socketPath: z.string(),
      pid: z.number(),
    })
    .parse(
      JSON.parse(
        await readFile(join(sessions, publisher, "control.json"), "utf8"),
      ),
    )
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 1000
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10))
  expect(predicate()).toBe(true)
}

describe("native private sessions", () => {
  test("two callers share one owner, actual private connection and independent creator/observer lifetimes", async () => {
    const owner = await hosted()
    const first = await openProxySession(options())
    const second = await openProxySession(options())
    expect(first.kind).toBe("managed")
    expect(second.kind).toBe("managed")
    if (first.kind !== "managed" || second.kind !== "managed")
      throw new Error("Expected managed sessions")
    expect(first.lifecycle.kind).toBe("creator")
    expect(second.lifecycle.kind).toBe("observer")
    expect(await first.connection()).toEqual(connection)
    expect(await second.read()).toEqual(await first.read())
    expect(JSON.stringify(await first.read())).not.toContain(
      "fixture-native-api-key",
    )
    const liveRecord = await record()
    expect(JSON.stringify(liveRecord)).not.toContain("fixture-native-api-key")
    expect((await stat(liveRecord.socketPath)).mode & 0o077).toBe(0)
    const snapshots: Array<number> = []
    const unsubscribe = second.subscribe((snapshot) => {
      if (snapshot.kind === "managed") snapshots.push(snapshot.revision)
    })
    await until(() => snapshots.length > 0)
    const before = owner.snapshot()
    if (before.kind !== "managed") throw new Error("Expected native snapshot")
    owner.replace(
      nativeSnapshotSchema.parse({
        ...before,
        revision: before.revision + 1,
        gatewayGeneration: before.gatewayGeneration + 1,
      }),
    )
    await until(() => snapshots.includes(before.revision + 1))
    if (first.lifecycle.kind !== "creator") throw new Error("Expected creator")
    expect((await first.lifecycle.stopCreatedGateway()).kind).toBe(
      "session-changed",
    )
    const current = await second.read()
    expect(current.kind === "managed" && current.gateway.kind).toBe("running")
    unsubscribe()
    await second.release()
    expect(
      owner.commands.filter((command) => command.kind === "stop-gateway"),
    ).toHaveLength(1)
    await first.release()
  })

  test("release never applies stop, while a matching creator lease can stop only its own generation", async () => {
    const owner = await hosted()
    const creator = await openProxySession(options({ manualApprove: true }))
    if (creator.kind !== "managed" || creator.lifecycle.kind !== "creator")
      throw new Error("Expected creator")
    expect((await creator.read()).kind).toBe("managed")
    expect(owner.commands[0]).toMatchObject({
      kind: "ensure-running",
      explicit: { manualApprove: true },
    })
    expect((await creator.lifecycle.stopCreatedGateway()).kind).toBe("applied")
    expect(
      owner.snapshot().kind === "managed" && owner.snapshot(),
    ).toMatchObject({ gateway: { kind: "stopped" } })
    await creator.release()
    expect(
      owner.commands.filter((command) => command.kind === "stop-gateway"),
    ).toHaveLength(1)
  })

  test("rejects wrong nonces, unknown commands and oversized input before dispatch", async () => {
    const owner = await hosted()
    const live = await record()
    for (const mutation of [
      { nonce: "0".repeat(64) },
      { command: { kind: "execute", command: "touch forbidden" } },
    ]) {
      const socket = createConnection(live.socketPath)
      socket.on("error", () => {})
      await once(socket, "connect")
      const closed = once(socket, "close")
      socket.write(
        JSON.stringify({
          protocol: 1,
          publisherId: live.publisherId,
          nonce: live.nonce,
          id: "attack",
          command: { kind: "invoke", intent: { kind: "sign-out" } },
          ...mutation,
        }) + "\n",
      )
      await closed
    }
    const socket = createConnection(live.socketPath)
    socket.on("error", () => {})
    await once(socket, "connect")
    const closed = once(socket, "close")
    socket.write("x".repeat(65_537))
    await closed
    expect(owner.commands).toHaveLength(0)
  })

  test("signed-out native provenance and malformed enrollment cannot fall back to plaintext credentials", async () => {
    await writeNativeCredentialProvenance({
      stateDirectory: options().stateDirectory,
      provenance: { kind: "native-authority", account: "signed-out" },
    })
    await writeFile(
      join(directory, "github_token"),
      "fixture-old-plaintext-token",
    )
    expect((await openProxySession(options())).kind).toBe("unavailable")
    await rm(join(options().stateDirectory, "credential-provenance.json"))
    await writeFile(
      join(options().stateDirectory, "installation.json"),
      "null",
      { mode: 0o600 },
    )
    expect((await openProxySession(options())).kind).toBe("unavailable")
    expect(await readFile(join(directory, "github_token"), "utf8")).toBe(
      "fixture-old-plaintext-token",
    )
  })

  test("rejects unsafe state/enrollment and changed package bytes without launching arbitrary executables", async () => {
    await mkdir(options().stateDirectory, { recursive: true, mode: 0o700 })
    await writeFile(
      join(options().stateDirectory, "installation.json"),
      JSON.stringify({
        kind: "copilot-proxy-native-installation",
        protocol: 1,
        executablePath: "/bin/sh",
        packageFingerprint: "0".repeat(64),
      }),
      { mode: 0o600 },
    )
    expect((await observeProxySession(options())).kind).toBe("unavailable")
    const app = join(directory, "Copilot Proxy.app", "Contents")
    const executable = join(app, "MacOS", "Copilot Proxy")
    await mkdir(dirname(executable), { recursive: true })
    await mkdir(join(app, "Resources", "app.asar.unpacked", "dist"), {
      recursive: true,
    })
    await writeFile(executable, "fixture-electron", { mode: 0o700 })
    await writeFile(
      join(app, "Info.plist"),
      "<plist><dict><key>CFBundleIdentifier</key><string>com.voidsteed.copilotproxy</string><key>CFBundleExecutable</key><string>Copilot Proxy</string></dict></plist>",
    )
    await writeFile(join(app, "Resources", "app.asar"), "fixture-package")
    await writeFile(
      join(app, "Resources", "app.asar.unpacked", "dist", "engine.cjs"),
      "fixture-engine",
    )
    const fingerprint = await nativePackageFingerprint(executable)
    await writeFile(
      join(options().stateDirectory, "installation.json"),
      JSON.stringify({
        kind: "copilot-proxy-native-installation",
        protocol: 1,
        executablePath: executable,
        packageFingerprint: fingerprint,
      }),
      { mode: 0o600 },
    )
    await writeFile(join(app, "Resources", "app.asar"), "changed-package")
    expect((await observeProxySession(options())).kind).toBe("unavailable")
    await rm(join(options().stateDirectory, "installation.json"))
    await chmod(options().stateDirectory, 0o755)
    expect((await observeProxySession(options())).kind).toBe("unavailable")
    await chmod(options().stateDirectory, 0o700)
  })

  test("a long state root uses a verified short alias whose socket stays in the injected root", async () => {
    const owner = await hosted()
    const live = await record()
    expect(Buffer.byteLength(live.socketPath)).toBeLessThan(104)
    expect(
      (await realpath(dirname(live.socketPath))).startsWith(
        await realpath(options().stateDirectory),
      ),
    ).toBe(true)
    expect(owner.commands).toHaveLength(0)
    const session = await observeProxySession(options())
    expect(session.kind).toBe("managed")
    if (session.kind === "managed") await session.release()
  })
})

describe("native source discovery", () => {
  test("a broker changing to a legacy attachment keeps observation and refuses account/runtime/old-lease changes", async () => {
    const owner = await hosted()
    const creator = await openProxySession(options())
    if (creator.kind !== "managed" || creator.lifecycle.kind !== "creator")
      throw new Error("Expected creator")
    const kinds: Array<string> = []
    const unsubscribe = creator.subscribe((snapshot) => {
      kinds.push(snapshot.kind)
    })
    await until(() => kinds.includes("managed"))
    owner.replace(
      legacySnapshotSchema.parse({
        kind: "legacy",
        connection: { ...connection, authentication: { kind: "none" } },
        status: "reachable",
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
        observedAt: "2026-10-30T12:00:00.000Z",
        totals: {
          requests: null,
          errors: null,
          inputTokens: null,
          outputTokens: null,
          cachedTokens: null,
        },
      }),
    )
    await until(() => kinds.includes("legacy"))
    expect((await creator.read()).kind).toBe("legacy")
    expect((await creator.connection())?.authentication.kind).toBe("none")
    expect((await creator.lifecycle.stopCreatedGateway()).kind).toBe(
      "session-changed",
    )
    expect((await creator.invoke({ kind: "sign-out" })).kind).toBe(
      "session-changed",
    )
    const before = owner.commands.length
    const observer = await openProxySession(options())
    expect(observer.kind).toBe("managed")
    expect(owner.commands).toHaveLength(before)
    if (observer.kind === "managed") {
      expect(observer.lifecycle.kind).toBe("observer")
      await observer.release()
    }
    expect(
      (await openProxySession(options({ manualApprove: true }))).kind,
    ).toBe("unavailable")
    expect(owner.commands).toHaveLength(before)
    unsubscribe()
    await creator.release()
  })

  test("wakes only the fingerprinted native executable with the fixed background argument", async () => {
    const app = join(directory, "Copilot Proxy.app", "Contents")
    const executable = join(app, "MacOS", "Copilot Proxy")
    const argumentsPath = join(directory, "background-arguments.json")
    const project = fileURLToPath(new URL("../", import.meta.url))
    await mkdir(dirname(executable), { recursive: true })
    await mkdir(join(app, "Resources", "app.asar.unpacked", "dist"), {
      recursive: true,
    })
    const running = nativeSnapshotSchema.parse({
      ...nativeSnapshot(),
      gatewayGeneration: 1,
      gateway: {
        kind: "running",
        connection: { ...connection, authentication: { kind: "keyed" } },
        startedAt: "2026-10-30T12:00:00.000Z",
      },
    })
    const script = `#!${process.execPath}
import { writeFile } from "node:fs/promises"
import { hostProxySession } from ${JSON.stringify(join(project, "src/lib/proxy-session.ts"))}
const snapshot = ${JSON.stringify(running)}
const connection = ${JSON.stringify(connection)}
let close
let closed = false
const shutdown = async () => { if (closed) return; closed = true; await close(); process.exit(0) }
const authority = {
  snapshot: () => snapshot,
  connection: () => connection,
  subscribe: () => () => {},
  dispatch(intent) {
    if (intent.kind === "sign-out") setTimeout(() => { void shutdown() }, 30)
    return Promise.resolve({ kind: "applied", snapshot, createdGateway: null })
  },
}
close = await hostProxySession({ stateDirectory: ${JSON.stringify(options().stateDirectory)}, authority, showUi: () => {} })
await writeFile(${JSON.stringify(argumentsPath)}, JSON.stringify(process.argv.slice(2)))
setTimeout(() => { void shutdown() }, 5000)
`
    await writeFile(executable, script, { mode: 0o700 })
    await writeFile(
      join(app, "Info.plist"),
      "<plist><dict><key>CFBundleIdentifier</key><string>com.voidsteed.copilotproxy</string><key>CFBundleExecutable</key><string>Copilot Proxy</string></dict></plist>",
    )
    await writeFile(join(app, "Resources", "app.asar"), "fixture-package")
    await writeFile(
      join(app, "Resources", "app.asar.unpacked", "dist", "engine.cjs"),
      "fixture-engine",
    )
    await mkdir(options().stateDirectory, { recursive: true, mode: 0o700 })
    await writeFile(
      join(options().stateDirectory, "installation.json"),
      JSON.stringify({
        kind: "copilot-proxy-native-installation",
        protocol: 1,
        executablePath: executable,
        packageFingerprint: await nativePackageFingerprint(executable),
      }),
      { mode: 0o600 },
    )
    const session = await openProxySession(options())
    expect(session.kind).toBe("managed")
    if (session.kind !== "managed") throw new Error("Expected native wake")
    try {
      expect(JSON.parse(await readFile(argumentsPath, "utf8"))).toEqual([
        "--background",
      ])
      const second = await openProxySession(options())
      expect(second.kind).toBe("managed")
      if (second.kind === "managed") {
        expect(await second.read()).toEqual(await session.read())
        await second.release()
      }
    } finally {
      await session.invoke({ kind: "sign-out" })
      await session.release()
      const sessions = join(options().stateDirectory, "sessions")
      const deadline = Date.now() + 2000
      while ((await readdir(sessions)).length > 0 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10))
      expect(await readdir(sessions)).toEqual([])
    }
  }, 10_000)

  test("a missing temporary socket alias stays a known unavailable native session and disposal still converges", async () => {
    await hosted()
    const live = await record()
    await unlink(dirname(live.socketPath))
    expect((await observeProxySession(options())).kind).toBe("unavailable")
    const dispose = disposals.pop()
    if (!dispose) throw new Error("Expected host disposal")
    await dispose()
    await dispose()
    expect(await readdir(join(options().stateDirectory, "sessions"))).toEqual(
      [],
    )
  })
})

describe("native control platform support", () => {
  test("platform capability keeps the verified macOS transport explicit and names unverified ownership/launcher limits", () => {
    expect(nativeControlCapability({ platform: "darwin" })).toEqual({
      kind: "supported",
      platform: "darwin",
      transport: "unix-socket",
    })
    expect(nativeControlCapability({ platform: "win32" })).toMatchObject({
      kind: "unsupported",
      platform: "win32",
    })
    const windows = nativeControlCapability({ platform: "win32" })
    const linux = nativeControlCapability({ platform: "linux" })
    expect(windows.kind === "unsupported" && windows.message).toContain(
      "ownership",
    )
    expect(linux.kind === "unsupported" && linux.message).toContain("AppImage")
  })

  test("unsupported private control preserves GUI authority while publishing no socket, nonce or unverified enrollment", async () => {
    for (const platform of ["win32", "linux"] as const) {
      const stateDirectory = join(directory, platform)
      await mkdir(stateDirectory, { mode: 0o755 })
      const owner = authority()
      const cleanup = await hostProxySession(
        {
          stateDirectory,
          authority: owner.api,
          showUi: () => {},
          installation: {
            executablePath: "/unverified/copilot-proxy.exe",
            packageFingerprint: "0".repeat(64),
          },
        },
        { platform },
      )
      expect(await readdir(stateDirectory)).toEqual([
        "native-control-unavailable.json",
      ])
      expect(
        JSON.parse(
          await readFile(
            join(stateDirectory, "native-control-unavailable.json"),
            "utf8",
          ),
        ),
      ).toEqual({
        kind: "copilot-proxy-native-control-unavailable",
        protocol: 1,
        platform,
      })
      expect((await stat(stateDirectory)).mode & 0o777).toBe(0o755)
      expect(owner.commands).toHaveLength(0)
      expect((await owner.api.dispatch(options().intent)).kind).toBe("applied")
      const session = await openProxySession({ ...options(), stateDirectory })
      expect(session.kind).toBe("unavailable")
      await cleanup()
      await cleanup()
      expect(
        owner.snapshot().kind === "managed" && owner.snapshot(),
      ).toMatchObject({ gateway: { kind: "running" } })
    }
  })

  test("nonsecret native provenance can persist without Unix permission assumptions, then blocks old CLI credentials", async () => {
    const stateDirectory = join(directory, "windows-state")
    await mkdir(stateDirectory, { mode: 0o755 })
    await writeNativeCredentialProvenance(
      {
        stateDirectory,
        provenance: { kind: "native-authority", account: "signed-out" },
      },
      { platform: "win32" },
    )
    expect(
      JSON.parse(
        await readFile(
          join(stateDirectory, "credential-provenance.json"),
          "utf8",
        ),
      ),
    ).toEqual({ kind: "native-authority", account: "signed-out" })
    expect(await readdir(stateDirectory)).toEqual([
      "credential-provenance.json",
      "native-control-unavailable.json",
    ])
    expect(
      (await openProxySession({ ...options(), stateDirectory })).kind,
    ).toBe("unavailable")
    expect((await stat(stateDirectory)).mode & 0o777).toBe(0o755)
  })

  test("a supported private host replaces the unsupported marker only after its validated channel opens", async () => {
    const stateDirectory = options().stateDirectory
    await writeNativeCredentialProvenance(
      {
        stateDirectory,
        provenance: { kind: "native-authority", account: "saved" },
      },
      { platform: "linux" },
    )
    expect((await observeProxySession(options())).kind).toBe("unavailable")
    const owner = authority()
    const cleanup = await hostProxySession(
      { stateDirectory, authority: owner.api, showUi: () => {} },
      { platform: "darwin" },
    )
    disposals.push(cleanup)
    expect(
      (await readdir(stateDirectory)).includes(
        "native-control-unavailable.json",
      ),
    ).toBe(false)
    const session = await observeProxySession(options())
    expect(session.kind).toBe("managed")
    if (session.kind === "managed") await session.release()
  })
})
