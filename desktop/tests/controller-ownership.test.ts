import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { build } from "esbuild"
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import type {
  CliStartCredential,
  ManagedSession,
  NativeSnapshot,
  RuntimeOverrides,
} from "../../src/lib/proxy-contracts"
import type { ControllerOptions, DesktopController } from "../main/types"

import {
  nativeSnapshotSchema,
  runtimeOptionsSchema,
} from "../../src/lib/proxy-contracts"
import { hostProxySession, openProxySession } from "../../src/lib/proxy-session"
import { monitorProxySession } from "../../src/start"
import { createController } from "../main/controller"
import { nativeRuntimeSettingsSchema } from "../main/settings-store"
import { settingsSchema } from "../shared/contracts"
import { startControllerUpstream } from "../testing/controller-upstream"
import { createMemoryCredentialVault } from "../testing/credential-vault"

const root = fileURLToPath(new URL("../../", import.meta.url))
const token = "fixture_github_token"
const key = "fixture_owned_key_012345678901234567890123456789"
const customKey = "fixture_custom_native_key_0123456789"
const cleanups: Array<() => Promise<void>> = []
let directory = ""
let runtimePath = ""
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "copilot-native-ownership-"))
  runtimePath = join(directory, "engine.cjs")
  await symlink(
    await realpath(join(root, "desktop/node_modules")),
    join(directory, "node_modules"),
  )
  await build({
    entryPoints: [join(root, "desktop/engine/index.ts")],
    outfile: runtimePath,
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
  if (directory) await rm(directory, { recursive: true, force: true })
})
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 6000
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10))
  expect(predicate()).toBe(true)
}
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("No fixture port")
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}
function nativeSnapshot(controller: DesktopController): NativeSnapshot {
  return nativeSnapshotSchema.parse(controller.sessionApi().snapshot())
}
async function fixture(
  options: { saved?: boolean; startOnLaunch?: boolean } = {},
) {
  const remote = await startControllerUpstream({
    token,
    overrideToken: "fixture_other_account",
  })
  cleanups.push(() => remote.close())
  const home = await mkdtemp(join(directory, "profile-"))
  const port = await freePort()
  const vault = createMemoryCredentialVault({
    githubToken: token,
    gatewayKey: key,
  })
  if (options.saved === false) await vault.vault.clear()
  await writeFile(
    join(home, "settings.json"),
    JSON.stringify({ port, startOnLaunch: options.startOnLaunch ?? false }),
  )
  const context = {
    home,
    port,
    remote,
    vault,
    stateDirectory: join(home, "native"),
  }
  const controller = await controllerFor(context)
  if (options.saved !== false)
    await until(() => controller.snapshot().account.kind === "signed-in")
  return { ...context, controller }
}
async function controllerFor(
  context: {
    home: string
    remote: { origin: string }
    vault: ReturnType<typeof createMemoryCredentialVault>
    stateDirectory: string
  },
  adapters: Pick<ControllerOptions, "applyLoginItem"> = {},
) {
  const controller = await createController({
    dataDirectory: context.home,
    homeDirectory: context.home,
    stateDirectory: context.stateDirectory,
    runtimePath,
    runtimeExecPath: "node",
    fixtureOrigin: context.remote.origin,
    platform: "darwin",
    version: "0.0.3",
    vault: context.vault.vault,
    writeClipboard: () => {},
    openExternal: () => Promise.resolve(),
    ...adapters,
  })
  cleanups.push(() => controller.dispose())
  return controller
}
async function served(controller: DesktopController): Promise<number> {
  const connection = controller.activeConnection()
  if (!connection) throw new Error("No active fixture gateway")
  const response = await fetch(connection.apiUrl + "/models", {
    headers:
      connection.authentication.kind === "keyed" ?
        { authorization: "Bearer " + connection.authentication.key }
      : {},
  })
  await response.text()
  return response.status
}
function lifecycle(
  session: Awaited<ReturnType<typeof openProxySession>>,
): ManagedSession {
  if (session.kind !== "managed")
    throw new Error("Expected private managed session")
  return session
}
async function simultaneous(options: {
  credential: CliStartCredential
  replace?: boolean
  signedOut?: boolean
}): Promise<void> {
  const context = await fixture({
    saved: !options.signedOut,
    startOnLaunch: options.signedOut,
  })
  let explicit: RuntimeOverrides = {}
  if (options.replace) {
    await context.controller.invoke({ kind: "start-gateway" })
    explicit = { port: await freePort(), responsesContextTrim: true }
  }
  const before = nativeSnapshot(context.controller)
  const authority = context.controller.sessionApi()
  const gate = Promise.withResolvers<undefined>()
  let arrivals = 0
  const host = await hostProxySession({
    stateDirectory: context.stateDirectory,
    authority: {
      ...authority,
      async dispatch(intent) {
        if (intent.kind === "ensure-running") {
          if (++arrivals === 2) gate.resolve(undefined)
          if (!options.signedOut) await gate.promise
        }
        return authority.dispatch(intent)
      },
    },
    showUi: () => {},
  })
  cleanups.push(host)
  const caller = {
    homeDirectory: context.home,
    stateDirectory: context.stateDirectory,
    intent: {
      kind: "ensure-running" as const,
      explicit,
      credential: options.credential,
    },
    discovery: { configuredAgents: [], savedRuntime: before.options },
  }
  const sessions =
    options.signedOut ?
      [
        await openProxySession(caller),
        await openProxySession({
          ...caller,
          intent: {
            ...caller.intent,
            credential: { kind: "native-saved-account" },
          },
        }),
      ]
    : await Promise.all([openProxySession(caller), openProxySession(caller)])
  const clients = sessions.map((session) => lifecycle(session))
  for (const client of clients) cleanups.push(() => client.release())
  expect(arrivals).toBe(2)
  expect(
    clients.filter((client) => client.lifecycle.kind === "creator"),
  ).toHaveLength(1)
  expect(
    clients.filter((client) => client.lifecycle.kind === "observer"),
  ).toHaveLength(1)
  const creator = clients.find((client) => client.lifecycle.kind === "creator")
  const observer = clients.find(
    (client) => client.lifecycle.kind === "observer",
  )
  if (!creator || !observer)
    throw new Error("Missing independent private lifetimes")
  const running = nativeSnapshot(context.controller)
  expect(Number(running.gatewayGeneration)).toBe(
    Number(before.gatewayGeneration) + 1,
  )
  const interrupt = new AbortController()
  const observing = monitorProxySession({
    session: observer,
    signal: interrupt.signal,
  })
  interrupt.abort()
  await observing
  expect(nativeSnapshot(context.controller).gatewayGeneration).toBe(
    running.gatewayGeneration,
  )
  expect(await served(context.controller)).toBe(200)
  const stop = new AbortController()
  const creating = monitorProxySession({
    session: creator,
    signal: stop.signal,
  })
  stop.abort()
  await creating
  expect(nativeSnapshot(context.controller).gateway.kind).toBe("stopped")
}
test(
  "simultaneous private saved-account clients grant one creator and an observer cannot stop it",
  () => simultaneous({ credential: { kind: "native-saved-account" } }),
  15_000,
)
test(
  "provided-token startup returns its creation receipt and later native observers cannot stop it",
  () =>
    simultaneous({
      signedOut: true,
      credential: {
        kind: "provided-token",
        value: token,
        persistence: "session",
      },
    }),
  15_000,
)
test(
  "simultaneous private runtime replacements grant one creator for the replacement",
  () =>
    simultaneous({
      replace: true,
      credential: { kind: "native-saved-account" },
    }),
  15_000,
)

async function anonymousLegacy(origin: string, port = 0) {
  const models = await fetch(origin + "/models", {
    headers: { authorization: "Bearer fixture_copilot_token" },
  })
  const usage = await fetch(origin + "/copilot_internal/user", {
    headers: { authorization: "token " + token },
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
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  )
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("No legacy fixture port")
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
  return { origin: "http://localhost:" + String(address.port), close }
}
test("refresh attaches a CLI started after initialization without changing native policy or agent configuration", async () => {
  const context = await fixture()
  const nativeRuntime = runtimeOptionsSchema.parse({
    ...nativeSnapshot(context.controller).options,
    rateLimitSeconds: 0.13,
    rateLimitWait: true,
    responsesContextTrim: true,
  })
  const applied = await context.controller.sessionApi().dispatch({
    kind: "update-runtime",
    explicit: {
      ...nativeRuntime,
      authentication: { kind: "keyed", keys: [customKey] },
    },
  })
  expect(applied.kind).toBe("applied")
  let legacyPort = await freePort()
  while (legacyPort === context.port) legacyPort = await freePort()
  await mkdir(join(context.home, ".claude"))
  const path = join(context.home, ".claude/settings.json")
  const agent = JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: "http://localhost:" + String(legacyPort) + "/",
      ANTHROPIC_AUTH_TOKEN: "dummy",
      ANTHROPIC_MODEL: "fixture-claude-sonnet[1m]",
    },
    permissions: { allow: ["Read"] },
  })
  await writeFile(path, agent)
  const before = await context.controller.invoke({ kind: "refresh" })
  expect(before.source.kind).toBe("native-managed")
  expect(before.gateway.kind).toBe("stopped")
  const native = nativeSnapshot(context.controller)
  expect(Number(native.gatewayGeneration)).toBe(0)
  expect(native.options).toEqual(nativeRuntime)
  expect(native.authentication).toEqual({ kind: "keyed" })
  expect(context.controller.activeConnection()).toBeNull()
  const saved = await readFile(join(context.home, "settings.json"), "utf8")
  expect(saved).not.toContain(customKey)
  const credentials = structuredClone(context.vault.read())
  const vaultWrites = context.vault.writes.length

  const legacy = await anonymousLegacy(context.remote.origin, legacyPort)
  const refreshed = await context.controller.invoke({ kind: "refresh" })
  expect(refreshed.source.kind).toBe("legacy-cli")
  expect(refreshed.gateway).toMatchObject({
    kind: "running",
    url: legacy.origin + "/v1",
  })
  const observed = context.controller.sessionApi().snapshot()
  expect(observed.kind).toBe("legacy")
  if (observed.kind !== "legacy")
    throw new Error("Expected attached CLI session")
  expect(observed.status).toBe("reachable")
  expect(observed.catalog.map((model) => model.id)).toContain(
    "fixture-responses-only",
  )
  expect(context.controller.activeConnection()?.authentication).toEqual({
    kind: "none",
  })
  expect(String(context.controller.activeConnection()?.rootUrl)).toBe(
    legacy.origin,
  )
  expect(refreshed.models).toEqual(observed.catalog)
  expect(
    refreshed.agentConfigs.find((view) => view.target === "claude-code"),
  ).toMatchObject({ status: "configured", rootUrl: legacy.origin + "/" })
  const nativeResponse = await fetch(
    "http://127.0.0.1:" + String(context.port) + "/v1/models",
  ).catch(() => null)
  expect(nativeResponse).toBeNull()
  expect(await readFile(join(context.home, "settings.json"), "utf8")).toBe(
    saved,
  )
  expect(await readFile(path, "utf8")).toBe(agent)
  expect(context.vault.read()).toEqual(credentials)
  expect(context.vault.writes).toHaveLength(vaultWrites)
}, 15_000)
test("private refresh reports the actual legacy session after discovering a late CLI", async () => {
  const context = await fixture()
  const authority = context.controller.sessionApi()
  const before = await authority.dispatch({ kind: "refresh" })
  expect(before.kind).toBe("applied")
  if (before.kind !== "applied")
    throw new Error("Expected an unchanged native session")
  expect(before.snapshot.kind).toBe("managed")
  expect(before.snapshot.gateway.kind).toBe("stopped")
  expect(before.createdGateway).toBeNull()
  const saved = await readFile(join(context.home, "settings.json"), "utf8")
  const credentials = structuredClone(context.vault.read())
  const vaultWrites = context.vault.writes.length
  const legacy = await anonymousLegacy(context.remote.origin, context.port)

  const refreshed = await authority.dispatch({ kind: "refresh" })
  expect(refreshed.kind).toBe("session-changed")
  if (refreshed.kind !== "session-changed")
    throw new Error("Expected the newly attached CLI session")
  expect(refreshed.snapshot).toEqual(authority.snapshot())
  expect(refreshed.snapshot).toMatchObject({
    kind: "legacy",
    status: "reachable",
    account: { kind: "external-unverified" },
    connection: {
      rootUrl: legacy.origin + "/",
      apiUrl: legacy.origin + "/v1",
      authentication: { kind: "none" },
    },
    capabilities: {
      kind: "legacy",
      runtime: "read-only",
      account: "unverified",
      activity: "observed",
      drain: false,
    },
  })
  expect(refreshed.snapshot.catalog.map((model) => model.id)).toContain(
    "fixture-responses-only",
  )
  expect(
    (
      await authority.dispatch({
        kind: "update-runtime",
        explicit: { responsesContextTrim: true },
      })
    ).kind,
  ).toBe("session-changed")
  expect(await readFile(join(context.home, "settings.json"), "utf8")).toBe(
    saved,
  )
  expect(context.vault.read()).toEqual(credentials)
  expect(context.vault.writes).toHaveLength(vaultWrites)
}, 15_000)
for (const outcome of ["completion", "cancellation"])
  test(
    "refresh preserves pending native authorization through " + outcome,
    async () => {
      const context = await fixture({ saved: false })
      const authority = context.controller.sessionApi()
      await mkdir(join(context.home, ".claude"))
      const agentPath = join(context.home, ".claude/settings.json")
      const agent = JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://localhost:" + String(context.port) + "/",
          ANTHROPIC_AUTH_TOKEN: "dummy",
          ANTHROPIC_MODEL: "fixture-claude-sonnet[1m]",
        },
        permissions: { allow: ["Read"] },
      })
      await writeFile(agentPath, agent)
      const saved = await readFile(join(context.home, "settings.json"), "utf8")
      context.remote.pendingOAuth(true)
      await authority.dispatch({ kind: "authorize" })
      await until(
        () => context.controller.snapshot().authorization.kind === "awaiting",
      )
      const pending = context.controller.snapshot()
      const before = nativeSnapshot(context.controller)
      const authorization = before.authorization
      if (authorization.kind !== "awaiting")
        throw new Error("Expected a pending native device code")
      const legacy = await anonymousLegacy(context.remote.origin, context.port)

      const refreshed = await context.controller.invoke({ kind: "refresh" })
      expect(refreshed.authorization).toEqual(authorization)
      expect(refreshed.account).toEqual(pending.account)
      expect(refreshed.source.kind).toBe("native-managed")
      expect({
        ...nativeSnapshot(context.controller),
        revision: before.revision,
      }).toEqual(before)
      expect(context.controller.activeConnection()).toBeNull()
      expect(await readFile(join(context.home, "settings.json"), "utf8")).toBe(
        saved,
      )
      expect(await readFile(agentPath, "utf8")).toBe(agent)
      expect(context.vault.read()).toBeNull()
      expect(context.vault.writes).toHaveLength(0)

      if (outcome === "completion") {
        context.remote.pendingOAuth(false)
        await until(
          () => context.controller.snapshot().account.kind === "signed-in",
        )
        const completed = nativeSnapshot(context.controller)
        expect(completed.account).toMatchObject({
          kind: "signed-in",
          login: "othercat",
          credentialSource: "native-vault",
        })
        expect(completed.authorization).toEqual({ kind: "idle" })
        expect(completed.gateway).toEqual({ kind: "stopped" })
        expect(completed.sessionId).toBe(before.sessionId)
        expect(completed.gatewayGeneration).toBe(before.gatewayGeneration)
        expect(context.controller.snapshot().source.kind).toBe("native-managed")
        expect(context.controller.activeConnection()).toBeNull()
        expect(context.vault.read()?.githubToken).toBe("fixture_other_account")
        expect(context.vault.writes).toHaveLength(1)
      } else {
        const cancelled = await authority.dispatch({
          kind: "cancel-authorization",
          authorizationId: authorization.id,
        })
        expect(cancelled.kind).toBe("applied")
        expect(nativeSnapshot(context.controller).authorization).toEqual({
          kind: "idle",
        })
        context.remote.pendingOAuth(false)
        const attached = await context.controller.invoke({ kind: "refresh" })
        expect(attached.source.kind).toBe("legacy-cli")
        expect(attached.account.kind).toBe("external-unverified")
        expect(attached.gateway).toMatchObject({
          kind: "running",
          url: legacy.origin + "/v1",
        })
        await context.controller.dispose()
        expect(context.vault.read()).toBeNull()
        expect(context.vault.writes).toHaveLength(0)
        expect(
          await readFile(join(context.home, "settings.json"), "utf8"),
        ).toBe(saved)
      }
      expect(await readFile(agentPath, "utf8")).toBe(agent)
    },
    15_000,
  )
const savedSettingsSchema = settingsSchema.extend({
  nativeRuntime: nativeRuntimeSettingsSchema.optional(),
})
async function legacyPreferences(
  storedRuntime: boolean,
  adapters: Pick<ControllerOptions, "applyLoginItem"> = {},
) {
  const context = await fixture()
  const runtime = runtimeOptionsSchema.parse({
    ...nativeSnapshot(context.controller).options,
    accountType: "business",
    rateLimitSeconds: 0.13,
    rateLimitWait: true,
    responsesContextTrim: true,
    proxyFromEnvironment: true,
  })
  const settings = {
    ...context.controller.snapshot().settings,

    port: runtime.port,
    accountType: runtime.accountType,
  }
  await context.controller.dispose()
  const encryptedAuthentication =
    await context.vault.vault.encodeRuntimeAuthentication?.({
      kind: "keyed",
      keys: [customKey],
    })
  if (!encryptedAuthentication) throw new Error("Missing encrypted fixture")
  const policy = {
    options: runtime,
    authentication: { kind: "keyed" },
    encryptedAuthentication,
  }
  const settingsPath = join(context.home, "settings.json")
  await writeFile(
    settingsPath,
    JSON.stringify({
      ...settings,
      ...(storedRuntime ? { nativeRuntime: policy } : {}),
    }),
  )
  const legacy = await anonymousLegacy(context.remote.origin)
  await mkdir(join(context.home, ".claude"))
  const agentPath = join(context.home, ".claude/settings.json")
  const agent = JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: legacy.origin + "/",
      ANTHROPIC_AUTH_TOKEN: "dummy",
      ANTHROPIC_MODEL: "fixture-claude-sonnet[1m]",
    },
    permissions: { allow: ["Read"] },
  })
  await writeFile(agentPath, agent)
  const controller = await controllerFor(context, adapters)
  expect(controller.snapshot().source.kind).toBe("legacy-cli")
  const credentialCalls: Array<string> = []
  const load = context.vault.vault.load.bind(context.vault.vault)
  const encodeRuntimeAuthentication =
    context.vault.vault.encodeRuntimeAuthentication?.bind(context.vault.vault)
  const decodeRuntimeAuthentication =
    context.vault.vault.decodeRuntimeAuthentication?.bind(context.vault.vault)
  context.vault.vault.load = () => {
    credentialCalls.push("load")
    return load()
  }
  if (encodeRuntimeAuthentication)
    context.vault.vault.encodeRuntimeAuthentication = (authentication) => {
      credentialCalls.push("encode")
      return encodeRuntimeAuthentication(authentication)
    }
  if (decodeRuntimeAuthentication)
    context.vault.vault.decodeRuntimeAuthentication = (encrypted) => {
      credentialCalls.push("decode")
      return decodeRuntimeAuthentication(encrypted)
    }
  return {
    ...context,
    controller,
    legacy,
    settingsPath,
    agentPath,
    agent,
    settings,
    runtime,
    credentialCalls,
    readSettings: async () =>
      savedSettingsSchema.parse(
        JSON.parse(await readFile(settingsPath, "utf8")),
      ),
  }
}
for (const storedRuntime of [true, false])
  test(
    "legacy preference writers preserve dormant native policy with stored runtime "
      + String(storedRuntime),
    async () => {
      const context = await legacyPreferences(storedRuntime)
      const before = await context.readSettings()
      const credentials = structuredClone(context.vault.read())
      const credentialWrites = context.vault.writes.length
      const observedPort = Number(new URL(context.legacy.origin).port)
      expect(observedPort).not.toBe(context.port)
      const commands = [
        {
          kind: "save-settings",
          settings: {
            ...context.controller.snapshot().settings,
            shell: "powershell",
            theme: "dark",
          },
        },
        { kind: "select-model", modelId: "fixture-responses-only" },
        {
          kind: "select-agent-model",
          target: "codex",
          modelId: "fixture-responses-only",
        },
      ]
      for (const command of commands) {
        const saved = await context.controller.invoke(command)
        expect(saved.notice).toBeNull()
        expect(saved.settings.port).toBe(observedPort)
        expect(saved.settings.accountType).toBe("business")
        const persisted = await context.readSettings()
        expect(persisted.port).toBe(context.port)
        expect(persisted.accountType).toBe("business")
        expect(persisted.nativeRuntime).toEqual(before.nativeRuntime)
        expect(await served(context.controller)).toBe(200)
      }
      const persisted = await context.readSettings()
      expect(persisted).toMatchObject({
        shell: "powershell",
        theme: "dark",
        preferredModel: "fixture-responses-only",
        agentModelChoices: { codex: "fixture-responses-only" },
      })
      await context.controller.invoke({
        kind: "save-settings",
        settings: context.controller.snapshot().settings,
      })
      expect(await context.readSettings()).toEqual(persisted)
      expect(await readFile(context.agentPath, "utf8")).toBe(context.agent)
      expect(context.vault.read()).toEqual(credentials)
      expect(context.vault.writes).toHaveLength(credentialWrites)
      expect(context.credentialCalls).toEqual([])
      await context.controller.dispose()
      const reloaded = await controllerFor(context)
      const { nativeRuntime: reloadedRuntime, ...preferences } = persisted
      expect(reloadedRuntime).toEqual(before.nativeRuntime)
      expect(reloaded.snapshot().settings).toEqual({
        ...preferences,
        port: observedPort,
      })
      await reloaded.invoke({
        kind: "save-settings",
        settings: reloaded.snapshot().settings,
      })
      expect(await context.readSettings()).toEqual(persisted)
      await reloaded.dispose()
      await context.legacy.close()
      const restored = await controllerFor(context)
      await until(() => restored.snapshot().account.kind === "signed-in")
      expect(nativeSnapshot(restored).options).toEqual(
        storedRuntime ?
          context.runtime
        : runtimeOptionsSchema.parse({
            ...context.runtime,
            rateLimitSeconds: null,
            rateLimitWait: false,
            responsesContextTrim: false,
            proxyFromEnvironment: false,
          }),
      )
      expect(restored.snapshot().settings.port).toBe(context.port)
      await restored.sessionApi().dispatch({
        kind: "ensure-running",
        credential: { kind: "native-saved-account" },
        explicit: {},
      })
      expect(restored.activeConnection()?.authentication).toEqual({
        kind: "keyed",
        key: storedRuntime ? customKey : key,
      })
      expect(await served(restored)).toBe(200)
      expect(await readFile(context.agentPath, "utf8")).toBe(context.agent)
    },
    15_000,
  )

test("legacy runtime edits are refused against displayed values without changing saved preferences", async () => {
  const context = await legacyPreferences(true)
  const saved = await readFile(context.settingsPath, "utf8")
  const previous = context.controller.snapshot().settings
  for (const edit of [{ port: context.port }, { accountType: "enterprise" }]) {
    const result = await context.controller.invoke({
      kind: "save-settings",
      settings: { ...previous, ...edit, theme: "dark" },
    })
    expect(result.notice?.kind).toBe("error")
    expect(result.settings).toEqual(previous)
    expect(await readFile(context.settingsPath, "utf8")).toBe(saved)
    expect(await served(context.controller)).toBe(200)
  }
  expect(context.credentialCalls).toEqual([])
}, 15_000)

for (const failure of ["save", "login-item"])
  test(
    "legacy preference "
      + failure
      + " failure preserves bytes and rolls back launch at login",
    async () => {
      const loginItems: Array<boolean> = []
      const context = await legacyPreferences(true, {
        applyLoginItem: (enabled) => {
          loginItems.push(enabled)
          if (failure === "login-item" && enabled)
            return Promise.reject(new Error("Fixture launch item failure"))
          return Promise.resolve()
        },
      })
      const saved = await readFile(context.settingsPath, "utf8")
      const previous = context.controller.snapshot().settings
      const backup = context.settingsPath + ".original"
      if (failure === "save") {
        await rename(context.settingsPath, backup)
        await mkdir(context.settingsPath)
      }
      const result = await context.controller.invoke({
        kind: "save-settings",
        settings: { ...previous, launchAtLogin: true, shell: "powershell" },
      })
      expect(result.notice?.kind).toBe("error")
      expect(result.settings).toEqual(previous)
      expect(loginItems).toEqual([true, false])
      if (failure === "save") {
        await rm(context.settingsPath, { recursive: true })
        await rename(backup, context.settingsPath)
      }
      expect(await readFile(context.settingsPath, "utf8")).toBe(saved)
      expect(await readFile(context.agentPath, "utf8")).toBe(context.agent)
      expect(context.credentialCalls).toEqual([])
      expect(await served(context.controller)).toBe(200)
      const retry = await context.controller.invoke({
        kind: "save-settings",
        settings: { ...previous, theme: "dark" },
      })
      expect(retry.notice).toBeNull()
      const persisted = await context.readSettings()
      expect(persisted.port).toBe(context.port)
      expect(persisted.nativeRuntime?.options).toEqual(context.runtime)
    },
    15_000,
  )
