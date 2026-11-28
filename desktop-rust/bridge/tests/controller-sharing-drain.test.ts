import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { build } from "esbuild"
import { fork } from "node:child_process"
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

import type { DesktopController } from "../main/types"

import { nativeSnapshotSchema } from "../../../src/lib/proxy-contracts"
import { createController } from "../main/controller"
import { settingsSchema } from "../shared/contracts"
import { startControllerUpstream } from "../testing/controller-upstream"
import { createMemoryCredentialVault } from "../testing/credential-vault"

const root = fileURLToPath(new URL("../../../", import.meta.url))
const token = "fixture_github_token"
const otherToken = "controller_drain_other_token"
const key = "controller_drain_key_012345678901234567890123456789"
const eventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready") }),
  z.object({
    kind: z.literal("drain-result"),
    result: z.object({ kind: z.literal("drained") }),
  }),
  z.object({ kind: z.literal("stopped") }),
])

const cleanups: Array<() => Promise<void>> = []
let fixtureDir = ""
let enginePath = ""

beforeAll(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), "copilot-proxy-hardening-"))
  enginePath = join(fixtureDir, "engine.cjs")
  await symlink(
    await realpath(join(root, "desktop-rust/bridge/node_modules")),
    join(fixtureDir, "node_modules"),
  )
  await build({
    entryPoints: [join(root, "desktop-rust/bridge/engine/index.ts")],
    outfile: enginePath,
    absWorkingDir: root,
    tsconfig: join(root, "tsconfig.json"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["pdf-parse"],
    logLevel: "silent",
  })
}, 30_000)

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

afterAll(async () => {
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true })
})

async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No test port")
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 6000
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10))
  expect(predicate()).toBe(true)
}

async function createNativeFixture() {
  const remote = await startControllerUpstream({
    token,
    overrideToken: otherToken,
  })
  cleanups.push(() => remote.close())
  const home = await mkdtemp(join(fixtureDir, "profile-"))
  const port = await availablePort()
  const vault = createMemoryCredentialVault({
    githubToken: token,
    gatewayKey: key,
  })
  await writeFile(
    join(home, "settings.json"),
    JSON.stringify({ port, startOnLaunch: false }),
  )
  const controller = await createController({
    dataDirectory: home,
    homeDirectory: home,
    stateDirectory: join(home, "native"),
    runtimePath: enginePath,
    runtimeExecPath: "node",
    fixtureOrigin: remote.origin,
    platform: "darwin",
    version: "0.0.8",
    vault: vault.vault,
    writeClipboard: () => {},
    openExternal: () => Promise.resolve(),
  })
  cleanups.push(() => controller.dispose())
  await until(() => controller.snapshot().account.kind === "signed-in")
  return { controller, home, port, remote, vault }
}

async function startLegacyCli(upstreamOrigin: string) {
  const models = await fetch(`${upstreamOrigin}/models`, {
    headers: { authorization: "Bearer fixture_copilot_token" },
  })
  const usage = await fetch(`${upstreamOrigin}/copilot_internal/user`, {
    headers: { authorization: `token ${token}` },
  })
  const replies = new Map([
    ["/models", await models.text()],
    ["/usage", await usage.text()],
    ["/debug/requests", JSON.stringify({ object: "list", data: [] })],
  ])
  const server = createServer((request, response) => {
    request.resume()
    const path = request.url ?? "/"
    if (path === "/") {
      response.end("Server running")
      return
    }
    const body = replies.get(path.replace(/^\/v1(?=\/models$)/, ""))
    response.setHeader("content-type", "application/json")
    response.statusCode = body === undefined ? 404 : 200
    response.end(body ?? JSON.stringify({ error: "Unknown fixture route" }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No legacy port")
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }
  cleanups.push(close)
  return { origin: `http://localhost:${String(address.port)}`, close }
}

async function createLegacyFixture() {
  const remote = await startControllerUpstream({
    token,
    overrideToken: otherToken,
  })
  cleanups.push(() => remote.close())
  const home = await mkdtemp(join(fixtureDir, "legacy-"))
  const port = await availablePort()
  const vault = createMemoryCredentialVault({
    githubToken: token,
    gatewayKey: key,
  })
  await writeFile(
    join(home, "settings.json"),
    JSON.stringify({ port, accountType: "business", startOnLaunch: false }),
  )
  const legacy = await startLegacyCli(remote.origin)
  await mkdir(join(home, ".claude"))
  await writeFile(
    join(home, ".claude/settings.json"),
    JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: `${legacy.origin}/`,
        ANTHROPIC_MODEL: "fixture-claude-sonnet[1m]",
      },
    }),
  )
  const controller = await createController({
    dataDirectory: home,
    homeDirectory: home,
    stateDirectory: join(home, "native"),
    runtimePath: enginePath,
    runtimeExecPath: "node",
    fixtureOrigin: remote.origin,
    platform: "darwin",
    version: "0.0.8",
    vault: vault.vault,
    writeClipboard: () => {},
    openExternal: () => Promise.resolve(),
  })
  cleanups.push(() => controller.dispose())
  expect(controller.snapshot().source.kind).toBe("legacy-cli")
  return { controller, home, port, legacy }
}

async function servedStatus(controller: DesktopController): Promise<number> {
  const connection = controller.activeConnection()
  if (!connection) throw new Error("No active connection")
  const response = await fetch(`${connection.apiUrl}/models`, {
    headers:
      connection.authentication.kind === "keyed" ?
        { authorization: `Bearer ${connection.authentication.key}` }
      : {},
  })
  await response.text()
  return response.status
}

test("the shipped Node listener drains the complete outgoing response before closing keepalive sockets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "copilot-proxy-node-drain-"))
  const libraryPath = join(directory, "listener.cjs")
  const runnerPath = join(directory, "node-listener.cjs")
  const port = await availablePort()
  let child: ReturnType<typeof fork> | undefined
  try {
    await symlink(
      await realpath(join(root, "desktop-rust/bridge/node_modules")),
      join(directory, "node_modules"),
    )
    await build({
      entryPoints: [join(root, "desktop-rust/bridge/engine/runtime.ts")],
      outfile: libraryPath,
      absWorkingDir: root,
      tsconfig: join(root, "tsconfig.json"),
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      external: ["pdf-parse"],
      logLevel: "silent",
    })
    await writeFile(
      runnerPath,
      [
        "const { createNodeListener } = require(process.argv[2])",
        "let stream",
        "const started = createNodeListener({port: Number(process.argv[3]), fetch: async (request) => {",
        "  await request.text()",
        String.raw`  return new Response(new ReadableStream({start(controller) { stream = controller; controller.enqueue(new TextEncoder().encode("data: first\n\n")) }}), {headers: {"content-type":"text/event-stream"}})`,
        "}})",
        'started.then(() => process.send({kind:"ready"}))',
        'process.on("message", async (message) => {',
        "  const listener = await started",
        '  if (message.kind === "drain") process.send({kind:"drain-result", result: await listener.drain(2000)})',
        String.raw`  if (message.kind === "finish") { stream.enqueue(new TextEncoder().encode("data: last\n\n")); stream.close() }`,
        '  if (message.kind === "stop") { await listener.stop(); process.send({kind:"stopped"}); process.exit(0) }',
        "})",
        'process.on("disconnect", () => { started.then((listener) => listener.forceStop()).then(() => process.exit(0)) })',
      ].join("\n"),
    )
    child = fork(runnerPath, [libraryPath, String(port)], {
      execPath: "node",
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    })
    const ready = Promise.withResolvers<undefined>()
    const drained = Promise.withResolvers<{ kind: "drained" }>()
    const exited = Promise.withResolvers<undefined>()
    let drainFinished = false
    child.on("message", (input: unknown) => {
      const event = eventSchema.parse(input)
      if (event.kind === "ready") ready.resolve(undefined)
      if (event.kind === "drain-result") {
        drainFinished = true
        drained.resolve(event.result)
      }
    })
    child.once("exit", () => exited.resolve(undefined))
    child.once("error", ready.reject)
    await ready.promise
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      body: "{}",
    })
    const reader = response.body?.getReader()
    expect((await reader?.read())?.done).toBe(false)
    child.send({ kind: "drain" })
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(drainFinished).toBe(false)
    child.send({ kind: "finish" })
    let text = ""
    if (reader)
      while (true) {
        const item = await reader.read()
        if (item.done) break
        if (item.value instanceof Uint8Array)
          text += new TextDecoder().decode(item.value)
      }
    expect(text).toContain("data: last")
    expect(await drained.promise).toEqual({ kind: "drained" })
    child.send({ kind: "stop" })
    await exited.promise
    expect(child.exitCode).toBe(0)
  } finally {
    child?.kill("SIGTERM")
    await rm(directory, { recursive: true, force: true })
  }
}, 10_000)

test("stop followed immediately by start never wedges in draining and preserves a coalesced CLI creator lease", async () => {
  const context = await createNativeFixture()
  await context.controller.execute({ kind: "start-gateway" })
  const before = nativeSnapshotSchema.parse(
    context.controller.sessionApi().snapshot(),
  )
  const [stopped, started] = await Promise.all([
    context.controller.execute({ kind: "stop-gateway" }),
    context.controller.sessionApi().dispatch({
      kind: "ensure-running",
      explicit: {},
      credential: { kind: "native-saved-account" },
    }),
  ])
  expect(stopped.outcome).toEqual({ kind: "ok" })
  expect(started.kind).toBe("applied")
  expect(context.controller.snapshot().gateway.kind).toBe("running")
  const after = nativeSnapshotSchema.parse(
    context.controller.sessionApi().snapshot(),
  )
  expect(after.gatewayGeneration).toBeGreaterThan(before.gatewayGeneration)
  if (started.kind === "applied") {
    expect(started.createdGateway).toEqual({
      sessionId: after.sessionId,
      gatewayGeneration: after.gatewayGeneration,
    })
  }
  expect(await servedStatus(context.controller)).toBe(200)
}, 15_000)

test("session-override CLI token and runtime overrides do not pollute settings.json", async () => {
  const context = await createNativeFixture()
  const settingsPath = join(context.home, "settings.json")
  const before = await readFile(settingsPath, "utf8")
  const overridePort = await availablePort()
  const started = await context.controller.sessionApi().dispatch({
    kind: "ensure-running",
    explicit: {
      port: overridePort,
      accountType: "business",
      responsesContextTrim: true,
      authentication: { kind: "none" },
    },
    credential: {
      kind: "provided-token",
      value: otherToken,
      persistence: "session",
    },
  })
  expect(started.kind).toBe("applied")
  expect(await readFile(settingsPath, "utf8")).toBe(before)

  const updated = await context.controller.sessionApi().dispatch({
    kind: "update-runtime",
    explicit: { rateLimitWait: true },
  })
  expect(updated.kind).toBe("applied")
  expect(await readFile(settingsPath, "utf8")).toBe(before)
}, 15_000)

test("sign-out clears in-session authentication and inspect-agent-config clears stale lastConfigureResult while preserving notices", async () => {
  const context = await createNativeFixture()
  await context.controller.execute({ kind: "start-gateway" })
  const firstAuth = context.controller.activeConnection()?.authentication
  expect(firstAuth?.kind).toBe("keyed")
  if (firstAuth?.kind !== "keyed") throw new Error("Expected keyed auth")

  const configured = await context.controller.execute({
    kind: "configure-agent",
    target: "codex",
  })
  expect(configured.outcome).toEqual({ kind: "ok" })
  expect(configured.snapshot.lastConfigureResult?.kind).toBe("added")

  const failedCopy = await context.controller.execute({
    kind: "copy",
    target: "device-code",
  })
  expect(failedCopy.outcome.kind).toBe("rejected")
  const activeNotice = failedCopy.snapshot.notice
  expect(activeNotice?.kind).toBe("error")

  await rm(join(context.home, ".codex/config.toml"))
  const inspected = await context.controller.execute({
    kind: "inspect-agent-config",
    target: "codex",
  })
  expect(inspected.outcome).toEqual({ kind: "ok" })
  expect(inspected.snapshot.lastConfigureResult).toBeNull()
  expect(inspected.snapshot.notice).toEqual(activeNotice)

  await context.controller.execute({
    kind: "configure-agent",
    target: "codex",
  })
  expect(context.controller.snapshot().lastConfigureResult).not.toBeNull()
  await context.controller.execute({ kind: "sign-out" })
  expect(context.controller.snapshot().lastConfigureResult).toBeNull()

  const second = await context.controller.sessionApi().dispatch({
    kind: "ensure-running",
    explicit: {},
    credential: {
      kind: "provided-token",
      value: otherToken,
      persistence: "session",
    },
  })
  expect(second.kind).toBe("applied")
  const secondAuth = context.controller.activeConnection()?.authentication
  expect(secondAuth?.kind).toBe("keyed")
  if (secondAuth?.kind !== "keyed") throw new Error("Expected keyed auth")
  expect(secondAuth.key).not.toBe(firstAuth.key)
}, 15_000)

test("partial save-settings in legacy mode succeeds and detach-legacy or start-gateway recovers an unreachable legacy CLI", async () => {
  const first = await createLegacyFixture()
  const updated = await first.controller.execute({
    kind: "save-settings",
    settings: { theme: "dark", shell: "powershell" },
  })
  expect(updated.outcome).toEqual({ kind: "ok" })
  expect(updated.snapshot.settings.theme).toBe("dark")
  expect(updated.snapshot.settings.shell).toBe("powershell")
  const persisted = settingsSchema.parse(
    JSON.parse(await readFile(join(first.home, "settings.json"), "utf8")),
  )
  expect(persisted.port).toBe(first.port)
  expect(persisted.theme).toBe("dark")
  expect(persisted.shell).toBe("powershell")

  await first.legacy.close()
  await first.controller.invoke({ kind: "refresh" })
  expect(first.controller.snapshot().source).toMatchObject({
    kind: "legacy-cli",
    status: "unreachable",
  })

  const detached = await first.controller.execute({ kind: "detach-legacy" })
  expect(detached.outcome).toEqual({ kind: "ok" })
  expect(detached.snapshot.source).toEqual({ kind: "none" })
  expect(detached.snapshot.gateway).toEqual({ kind: "stopped" })
  expect(detached.snapshot.connection).toBeNull()
  expect(detached.snapshot.runtime).toBeNull()
  expect(detached.snapshot.account.kind).toBe("signed-in")

  const started = await first.controller.execute({ kind: "start-gateway" })
  expect(started.outcome).toEqual({ kind: "ok" })
  expect(started.snapshot.source.kind).toBe("native-managed")
  expect(started.snapshot.gateway.kind).toBe("running")
  expect(await servedStatus(first.controller)).toBe(200)

  const second = await createLegacyFixture()
  await second.legacy.close()
  await second.controller.invoke({ kind: "refresh" })
  const autoStarted = await second.controller.execute({ kind: "start-gateway" })
  expect(autoStarted.outcome).toEqual({ kind: "ok" })
  expect(autoStarted.snapshot.source.kind).toBe("native-managed")
  expect(autoStarted.snapshot.gateway.kind).toBe("running")
  expect(await servedStatus(second.controller)).toBe(200)
}, 15_000)
