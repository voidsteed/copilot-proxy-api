import { expect, test } from "bun:test"
import { build } from "esbuild"
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import type { CredentialVault, DesktopController } from "../main/types"

import {
  cliProxyOptions,
  hostProxySession,
  nativeControlCapability,
  openProxySession,
} from "../../src/lib/proxy-session"
import { runStart, type RunServerOptions } from "../../src/start"
import { upstreamCatalogSchema } from "../engine/upstream"
import { createController } from "../main/controller"
import { startFixtureUpstream } from "../testing/upstream"

const root = fileURLToPath(new URL("../../", import.meta.url))
const privateControl = nativeControlCapability()
const darwinTest = test.skipIf(privateControl.kind !== "supported")
const noopClipboard = () => {}
const noopExternal = () => Promise.resolve()
const noopShowUi = () => {}

async function reservePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      probe.removeListener("error", reject)
      resolve()
    })
  })
  const address = probe.address()
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  if (!address || typeof address === "string")
    throw new Error("No available test port.")
  return address.port
}

async function startLegacyCli(upstreamOrigin: string) {
  const modelsResponse = await fetch(`${upstreamOrigin}/models`, {
    headers: { authorization: "Bearer fixture_copilot_token" },
  })
  expect(modelsResponse.status).toBe(200)
  const catalog = upstreamCatalogSchema.parse(await modelsResponse.json())
  const model = catalog.data.find((item) => item.capabilities.type === "chat")
  if (!model) throw new Error("Missing fixture chat model.")
  const usageResponse = await fetch(`${upstreamOrigin}/copilot_internal/user`, {
    headers: { authorization: "token fixture_github_token" },
  })
  expect(usageResponse.status).toBe(200)
  const replies = new Map([
    ["/models", JSON.stringify({ ...catalog, data: [model] })],
    ["/usage", await usageResponse.text()],
  ])
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname
    request.resume()
    if (request.method === "GET" && pathname === "/") {
      response.end("Server running")
      return
    }
    response.setHeader("content-type", "application/json")
    const body =
      pathname === "/debug/requests" ?
        JSON.stringify({ object: "list", data: [] })
      : replies.get(pathname.replace(/^\/v1(?=\/models$)/, ""))
    response.statusCode = body === undefined ? 404 : 200
    response.end(body ?? JSON.stringify({ error: "Not found" }))
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
    throw new Error("No CLI test port.")
  return {
    port: address.port,
    origin: `http://localhost:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
  }
}

async function buildTestEngine(directory: string): Promise<string> {
  const runtimePath = join(directory, "engine.cjs")
  await symlink(
    await realpath(join(root, "desktop/node_modules")),
    join(directory, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  )
  await build({
    entryPoints: [join(root, "desktop/engine/index.ts")],
    outfile: runtimePath,
    absWorkingDir: root,
    tsconfig: join(root, "tsconfig.json"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["pdf-parse"],
    logLevel: "silent",
  })
  return runtimePath
}

function makeVault(gatewayKey: string | null): CredentialVault {
  return {
    mode: "session-only",
    load: () =>
      Promise.resolve(
        gatewayKey ? { githubToken: "fixture_github_token", gatewayKey } : null,
      ),
    save: () => Promise.resolve(),
    clear: () => Promise.resolve(),
  }
}

test("changing port in Settings while observing a live Terminal CLI detaches CLI, preserves it, starts Desktop on the new port, and survives reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "copilot-port-switch-"))
  const upstream = await startFixtureUpstream()
  const cli = await startLegacyCli(upstream.origin)
  const desktopPort = await reservePort()
  const gatewayKey = "fixture_desktop_port_key_01234567890123456789"
  let controller: DesktopController | undefined
  let reopened: DesktopController | undefined
  try {
    const runtimePath = await buildTestEngine(directory)
    await writeFile(
      join(directory, "settings.json"),
      JSON.stringify({ port: cli.port, startOnLaunch: true }),
    )
    await mkdir(join(directory, ".claude"))
    await writeFile(
      join(directory, ".claude", "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: `${cli.origin}/` } }),
    )
    const options = {
      dataDirectory: directory,
      homeDirectory: directory,
      stateDirectory: join(directory, "native"),
      runtimePath,
      runtimeExecPath: "node",
      fixtureOrigin: upstream.origin,
      platform: "darwin" as const,
      version: "0.0.8",
      vault: makeVault(gatewayKey),
      writeClipboard: noopClipboard,
      openExternal: noopExternal,
    }
    controller = await createController(options)
    expect(controller.snapshot().source.kind).toBe("legacy-cli")
    expect(controller.snapshot().settings.port).toBe(cli.port)

    const updated = await controller.invoke({
      kind: "save-settings",
      settings: { port: desktopPort },
    })
    expect(updated.source.kind).toBe("native-managed")
    expect(updated.settings.port).toBe(desktopPort)
    expect(updated.gateway.kind).toBe("running")
    expect(String(updated.connection?.apiUrl)).toBe(
      `http://127.0.0.1:${String(desktopPort)}/v1`,
    )

    const desktopResponse = await fetch(
      `http://127.0.0.1:${String(desktopPort)}/models`,
      { headers: { authorization: `Bearer ${gatewayKey}` } },
    )
    expect(desktopResponse.status).toBe(200)
    await desktopResponse.text()
    expect(await (await fetch(cli.origin)).text()).toBe("Server running")

    await controller.dispose()
    controller = undefined

    reopened = await createController(options)
    const deadline = Date.now() + 8000
    while (
      Date.now() < deadline
      && (reopened.snapshot().source.kind !== "native-managed"
        || reopened.snapshot().gateway.kind !== "running")
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(reopened.snapshot().source.kind).toBe("native-managed")
    expect(reopened.snapshot().settings.port).toBe(desktopPort)
    expect(reopened.snapshot().gateway.kind).toBe("running")
    expect(await (await fetch(cli.origin)).text()).toBe("Server running")
  } finally {
    await reopened?.dispose()
    await controller?.dispose()
    await cli.close()
    await upstream.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 20_000)

darwinTest(
  "stopping a legacy CLI and immediately running shared start detaches the dead legacy session and starts the managed gateway",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "copilot-legacy-recovery-"))
    const upstream = await startFixtureUpstream()
    const cli = await startLegacyCli(upstream.origin)
    const gatewayKey = "fixture_recovered_key_01234567890123456789"
    let controller: DesktopController | undefined
    let stopControl: (() => Promise<void>) | undefined
    let cliClosed = false
    try {
      const runtimePath = await buildTestEngine(directory)
      await writeFile(
        join(directory, "settings.json"),
        JSON.stringify({ port: cli.port, startOnLaunch: false }),
      )
      const stateDirectory = join(directory, "native")
      controller = await createController({
        dataDirectory: directory,
        homeDirectory: directory,
        stateDirectory,
        runtimePath,
        runtimeExecPath: "node",
        fixtureOrigin: upstream.origin,
        platform: "darwin",
        version: "0.0.8",
        vault: makeVault(gatewayKey),
        writeClipboard: noopClipboard,
        openExternal: noopExternal,
      })
      expect(controller.snapshot().source.kind).toBe("legacy-cli")
      stopControl = await hostProxySession({
        stateDirectory,
        authority: controller.sessionApi(),
        showUi: noopShowUi,
      })

      await cli.close()
      cliClosed = true
      expect(controller.sessionApi().snapshot()).toMatchObject({
        kind: "legacy",
        status: "reachable",
      })

      const values: RunServerOptions = {
        port: cli.port,
        shared: true,
        verbose: false,
        accountType: "individual",
        manual: false,
        rateLimitWait: false,
        claudeCode: false,
        showToken: false,
        proxyEnv: false,
        responsesContextTrim: false,
      }
      const abort = new AbortController()
      const starting = runStart({
        homeDirectory: directory,
        stateDirectory,
        values,
        explicit: {},
        signal: abort.signal,
      })

      const deadline = Date.now() + 8000
      while (
        Date.now() < deadline
        && (controller.snapshot().source.kind !== "native-managed"
          || controller.snapshot().gateway.kind !== "running")
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(controller.snapshot().source.kind).toBe("native-managed")
      expect(controller.snapshot().gateway.kind).toBe("running")
      const response = await fetch(`${cli.origin}/models`, {
        headers: { authorization: `Bearer ${gatewayKey}` },
      })
      expect(response.status).toBe(200)
      await response.text()

      abort.abort()
      await starting
      expect(controller.snapshot().gateway.kind).toBe("stopped")
    } finally {
      await stopControl?.()
      await controller?.dispose()
      if (!cliClosed) await cli.close()
      await upstream.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
  15_000,
)

darwinTest(
  "an unsigned-in desktop observer detaches a stopped legacy CLI and lets shared openProxySession fall back to standalone",
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "copilot-observer-fallback-"),
    )
    const upstream = await startFixtureUpstream()
    const cli = await startLegacyCli(upstream.origin)
    let controller: DesktopController | undefined
    let stopControl: (() => Promise<void>) | undefined
    let cliClosed = false
    try {
      await writeFile(
        join(directory, "settings.json"),
        JSON.stringify({ port: cli.port, startOnLaunch: false }),
      )
      const stateDirectory = join(directory, "native")
      controller = await createController({
        dataDirectory: directory,
        homeDirectory: directory,
        stateDirectory,
        runtimePath: join(directory, "unused-engine.cjs"),
        runtimeExecPath: "node",
        fixtureOrigin: upstream.origin,
        platform: "darwin",
        version: "0.0.8",
        vault: makeVault(null),
        writeClipboard: noopClipboard,
        openExternal: noopExternal,
      })
      expect(controller.snapshot().source.kind).toBe("legacy-cli")
      stopControl = await hostProxySession({
        stateDirectory,
        authority: controller.sessionApi(),
        showUi: noopShowUi,
      })

      await cli.close()
      cliClosed = true

      const session = await openProxySession({
        ...(await cliProxyOptions({
          homeDirectory: directory,
          stateDirectory,
        })),
        intent: {
          kind: "ensure-running",
          explicit: {},
          credential: { kind: "native-saved-account" },
        },
      })
      expect(session.kind).toBe("standalone")
      expect(controller.snapshot().source.kind).toBe("none")
      expect(controller.snapshot().account.kind).toBe("signed-out")
    } finally {
      await stopControl?.()
      await controller?.dispose()
      if (!cliClosed) await cli.close()
      await upstream.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
  10_000,
)

test("GUI start-gateway detaches a freshly stopped legacy CLI on the first click", async () => {
  const directory = await mkdtemp(join(tmpdir(), "copilot-gui-first-click-"))
  const upstream = await startFixtureUpstream()
  const cli = await startLegacyCli(upstream.origin)
  let controller: DesktopController | undefined
  let cliClosed = false
  try {
    const runtimePath = await buildTestEngine(directory)
    await writeFile(
      join(directory, "settings.json"),
      JSON.stringify({ port: cli.port, startOnLaunch: false }),
    )
    controller = await createController({
      dataDirectory: directory,
      homeDirectory: directory,
      stateDirectory: join(directory, "native"),
      runtimePath,
      runtimeExecPath: "node",
      fixtureOrigin: upstream.origin,
      platform: "darwin",
      version: "0.0.8",
      vault: makeVault("fixture_gui_click_key_01234567890123456789"),
      writeClipboard: noopClipboard,
      openExternal: noopExternal,
    })
    expect(controller.snapshot().source.kind).toBe("legacy-cli")

    await cli.close()
    cliClosed = true

    const snapshot = await controller.invoke({ kind: "start-gateway" })
    expect(snapshot.source.kind).toBe("native-managed")
    expect(snapshot.gateway.kind).toBe("running")
  } finally {
    await controller?.dispose()
    if (!cliClosed) await cli.close()
    await upstream.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)
