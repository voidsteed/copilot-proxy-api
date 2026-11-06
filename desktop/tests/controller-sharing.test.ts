import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test"
import { build } from "esbuild"
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
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

import type {
  CreatorLease,
  NativeIntent,
  NativeSnapshot,
  RuntimeOverrides,
} from "../../src/lib/proxy-contracts"
import type { CredentialVault, DesktopController } from "../main/types"

import { loopbackApiUrlSchema } from "../../src/lib/proxy-contracts"
import {
  creatorLeaseSchema,
  nativeSnapshotSchema,
} from "../../src/lib/proxy-contracts"
import { createController } from "../main/controller"
import { startControllerUpstream } from "../testing/controller-upstream"
import { createMemoryCredentialVault } from "../testing/credential-vault"
const root = fileURLToPath(new URL("../../", import.meta.url))
const key = "controller_sharing_key_012345678901234567890123456789"
const token = "fixture_github_token"
const otherToken = "controller_other_session_token"
const cleanups: Array<() => Promise<void>> = []
let directory = ""
let runtimePath = ""
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "copilot-proxy-controller-sharing-"))
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
}, 30000)
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})
async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 6000
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10))
  expect(predicate()).toBe(true)
}
async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("No isolated test port")
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}
async function upstream() {
  const remote = await startControllerUpstream({
    token,
    overrideToken: otherToken,
  })
  cleanups.push(() => remote.close())
  return remote
}
function memoryVault() {
  return createMemoryCredentialVault({ githubToken: token, gatewayKey: key })
}
async function native(
  options: {
    vault?: CredentialVault
    initial?: (home: string, port: number) => Promise<void>
  } = {},
) {
  const remote = await upstream()
  const homeDirectory = await mkdtemp(join(directory, "home-"))
  const stateDirectory = join(homeDirectory, "native")
  const port = await availablePort()
  await writeFile(
    join(homeDirectory, "settings.json"),
    JSON.stringify({ port, startOnLaunch: false }),
  )
  await options.initial?.(homeDirectory, port)
  const store = memoryVault()
  const folders: Array<string> = []
  const clipboard: Array<string> = []
  let shown = 0
  const controller = await createController({
    dataDirectory: homeDirectory,
    stateDirectory,
    runtimePath,
    runtimeExecPath: "node",
    fixtureOrigin: remote.origin,
    platform: "darwin",
    version: "0.0.3",
    vault: options.vault ?? store.vault,
    writeClipboard: (text) => {
      clipboard.push(text)
    },
    openExternal: async () => {},
    openFolder: (path) => {
      folders.push(path)
      return Promise.resolve()
    },
    showUi: () => {
      shown++
    },
  })
  cleanups.push(() => controller.dispose())
  await eventually(() => controller.snapshot().account.kind === "signed-in")
  return {
    controller,
    vault: options.vault ?? store.vault,
    store,
    remote,
    homeDirectory,
    stateDirectory,
    port,
    folders,
    clipboard,
    shown: () => shown,
  }
}
async function reopen(
  context: Awaited<ReturnType<typeof native>>,
): Promise<DesktopController> {
  await context.controller.dispose()
  const controller = await createController({
    dataDirectory: context.homeDirectory,
    homeDirectory: context.homeDirectory,
    stateDirectory: context.stateDirectory,
    runtimePath,
    runtimeExecPath: "node",
    fixtureOrigin: context.remote.origin,
    platform: "darwin",
    version: "0.0.3",
    vault: context.vault,
    writeClipboard: () => {},
    openExternal: () => Promise.resolve(),
  })
  cleanups.push(() => controller.dispose())
  await eventually(() => controller.snapshot().account.kind === "signed-in")
  return controller
}
function snapshot(controller: DesktopController): NativeSnapshot {
  const value = nativeSnapshotSchema.parse(controller.sessionApi().snapshot())
  const serialized = JSON.stringify(value)
  expect(serialized).not.toContain(token)
  expect(serialized).not.toContain(otherToken)
  expect(serialized).not.toContain(key)
  return value
}
function lease(controller: DesktopController): CreatorLease {
  const value = snapshot(controller)
  return creatorLeaseSchema.parse({
    sessionId: value.sessionId,
    gatewayGeneration: value.gatewayGeneration,
  })
}
async function start(
  controller: DesktopController,
  explicit: RuntimeOverrides = {},
) {
  const result = await controller.sessionApi().dispatch({
    kind: "ensure-running",
    explicit,
    credential: { kind: "native-saved-account" },
  })
  expect(result.kind).toBe("applied")
  expect(controller.snapshot().gateway.kind).toBe("running")
  return result
}
function post(
  port: number,
  input: string,
  options: { signal?: AbortSignal; authorization?: string | null } = {},
) {
  const { signal } = options
  const authorization =
    options.authorization === undefined ? key : options.authorization
  return fetch("http://127.0.0.1:" + String(port) + "/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization: "Bearer " + authorization } : {}),
    },
    body: JSON.stringify({
      model: "fixture-responses-only",
      input,
      stream: input === "fixture:long",
    }),
    signal,
  })
}
describe("shared native authority", () => {
  test("anonymous and keyed clients use all loopback host spellings and explicit overrides survive a repeated start", async () => {
    const context = await native()
    expect(
      snapshot(context.controller).catalog.map((model) => model.id),
    ).toContain("fixture-embeddings")
    await start(context.controller, {
      authentication: { kind: "none" },
      rateLimitSeconds: 0.2,
      rateLimitWait: false,
      responsesContextTrim: true,
    })
    const before = snapshot(context.controller)
    for (const host of ["127.0.0.1", "localhost", "[::1]"])
      expect(
        (
          await fetch(
            "http://" + host + ":" + String(context.port) + "/v1/models",
          )
        ).status,
      ).toBe(200)
    const first = await post(context.port, "Check the connection", {
      signal: undefined,
      authorization: null,
    })
    expect(first.status).toBe(200)
    await first.text()
    const limited = await post(context.port, "Check the connection", {
      signal: undefined,
      authorization: null,
    })
    expect(limited.status).toBe(429)
    await limited.text()
    await start(context.controller)
    expect(snapshot(context.controller).options).toEqual(before.options)
    expect(snapshot(context.controller).gatewayGeneration).toBe(
      before.gatewayGeneration,
    )
    const actualKey = "controller_actual_key"
    const changed = await context.controller.sessionApi().dispatch({
      kind: "update-runtime",
      explicit: {
        authentication: { kind: "keyed", keys: [actualKey] },
        rateLimitSeconds: null,
      },
    })
    expect(changed.kind).toBe("applied")
    expect(context.controller.activeConnection()?.authentication).toEqual({
      kind: "keyed",
      key: actualKey,
    })
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      const url = "http://" + host + ":" + String(context.port) + "/v1/models"
      expect((await fetch(url)).status).toBe(401)
      expect(
        (
          await fetch(url, {
            headers: { authorization: "Bearer " + actualKey },
          })
        ).status,
      ).toBe(200)
    }
    expect(JSON.stringify(snapshot(context.controller))).not.toContain(
      actualKey,
    )
  }, 15000)
  test("a creator lease cannot stop a replacement gateway or grant renderer token control", async () => {
    const context = await native()
    const created = await start(context.controller)
    expect(created.kind === "applied" && created.createdGateway).toEqual(
      lease(context.controller),
    )
    const original = lease(context.controller)
    await context.controller.sessionApi().dispatch({
      kind: "update-runtime",
      explicit: { responsesContextTrim: true },
    })
    expect(snapshot(context.controller).gatewayGeneration).toBeGreaterThan(
      original.gatewayGeneration,
    )
    const stopped = await context.controller
      .sessionApi()
      .dispatch({ kind: "stop-gateway", expected: original, timeoutMs: 100 })
    expect(stopped.kind).toBe("session-changed")
    expect(context.controller.snapshot().gateway.kind).toBe("running")
    const rejected = await context.controller.invoke({
      kind: "authorize-with-token",
      token: otherToken,
      persistence: "session",
    })
    expect(rejected.notice?.kind).toBe("error")
    expect(snapshot(context.controller).account).toMatchObject({
      kind: "signed-in",
      login: "octocat",
      credentialSource: "native-vault",
    })
    expect((await post(context.port, "Check the connection")).status).toBe(200)
    await context.controller.sessionApi().dispatch({ kind: "show-ui" })
    expect(context.shown()).toBe(1)
    const applied = await context.controller.sessionApi().dispatch({
      kind: "stop-gateway",
      expected: lease(context.controller),
      timeoutMs: 100,
    })
    expect(applied.kind).toBe("applied")
    expect(context.controller.activeConnection()).toBeNull()
  }, 15000)
  test("drain timeout keeps an active stream connected and resumes the same gateway", async () => {
    const context = await native()
    await start(context.controller)
    const before = context.controller.snapshot().gateway
    const abort = new AbortController()
    const response = await post(context.port, "fixture:long", {
      signal: abort.signal,
    })
    const reader = response.body?.getReader()
    expect((await reader?.read())?.done).toBe(false)
    const drained = await context.controller.sessionApi().dispatch({
      kind: "drain-gateway",
      expected: lease(context.controller),
      timeoutMs: 50,
    })
    expect(drained.kind).toBe("unavailable")
    expect(context.controller.snapshot().gateway).toEqual(before)
    expect((await reader?.read())?.done).toBe(false)
    const request = await post(context.port, "Check the connection")
    expect(request.status).toBe(200)
    await request.text()
    abort.abort()
    await reader?.cancel().catch(() => undefined)
  }, 10000)
  test("settings replacement waits for actual stream close and rejects new inference during drain", async () => {
    const context = await native()
    await start(context.controller)
    const original = lease(context.controller)
    const abort = new AbortController()
    const response = await post(context.port, "fixture:long", {
      signal: abort.signal,
    })
    const reader = response.body?.getReader()
    expect((await reader?.read())?.done).toBe(false)
    const nextPort = await availablePort()
    let applied = false
    const changed = context.controller
      .invoke({
        kind: "save-settings",
        settings: { ...context.controller.snapshot().settings, port: nextPort },
      })
      .then((value) => {
        applied = true
        return value
      })
    await eventually(
      () => context.controller.snapshot().gateway.kind === "draining",
    )
    expect(applied).toBe(false)
    expect(context.controller.snapshot().settings.port).toBe(context.port)
    const rejected = await post(context.port, "Check the connection")
    expect(rejected.status).toBe(503)
    await rejected.text()
    expect((await reader?.read())?.done).toBe(false)
    abort.abort()
    await reader?.cancel().catch(() => undefined)
    const result = await changed
    expect(result.gateway).toMatchObject({
      kind: "running",
      url: "http://127.0.0.1:" + String(nextPort) + "/v1",
    })
    expect(snapshot(context.controller).gatewayGeneration).toBeGreaterThan(
      original.gatewayGeneration,
    )
    const fresh = await post(nextPort, "Check the connection")
    expect(fresh.status).toBe(200)
    await fresh.text()
  }, 15000)
})
describe("native account replacement", () => {
  test("cancelled approval and failed encrypted save preserve the current account and gateway", async () => {
    const store = memoryVault()
    const context = await native({ vault: store.vault })
    await start(context.controller)
    const before = snapshot(context.controller)
    const beforeGateway = context.controller.snapshot().gateway
    context.remote.pendingOAuth(true)
    await context.controller.sessionApi().dispatch({ kind: "authorize" })
    await eventually(
      () => context.controller.snapshot().authorization.kind === "awaiting",
    )
    const authorization = context.controller.snapshot().authorization
    if (authorization.kind !== "awaiting")
      throw new Error("No authorization attempt")
    expect(snapshot(context.controller).account).toEqual(before.account)
    await context.controller.sessionApi().dispatch({
      kind: "cancel-authorization",
      authorizationId: authorization.id,
    })
    context.remote.pendingOAuth(false)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(snapshot(context.controller).account).toEqual(before.account)
    expect(context.controller.snapshot().gateway).toEqual(beforeGateway)
    store.fail(true)
    await context.controller.sessionApi().dispatch({ kind: "authorize" })
    await eventually(
      () => context.controller.snapshot().authorization.kind === "error",
    )
    expect(snapshot(context.controller).account).toEqual(before.account)
    expect(context.controller.snapshot().gateway).toEqual(beforeGateway)
    expect(store.read()).toEqual({ githubToken: token, gatewayKey: key })
    const existing = await post(context.port, "Check the connection")
    expect(existing.status).toBe(200)
    await existing.text()
  }, 15000)
  test("a supplied CLI token stays session-only and sign-out records native provenance", async () => {
    const context = await native()
    await start(context.controller)
    const request: NativeIntent = {
      kind: "authorize-with-token",
      token: otherToken,
      persistence: "session",
    }
    const result = await context.controller.sessionApi().dispatch(request)
    expect(result.kind).toBe("applied")
    expect(snapshot(context.controller).account).toMatchObject({
      kind: "signed-in",
      login: "othercat",
      credentialSource: "session-override",
    })
    expect(context.store.read()).toEqual({
      githubToken: token,
      gatewayKey: key,
    })
    expect(context.store.writes).toHaveLength(0)
    const served = await post(context.port, "Check the connection")
    expect(served.status).toBe(200)
    await served.text()
    await context.controller.sessionApi().dispatch({ kind: "sign-out" })
    expect(context.store.read()).toBeNull()
    expect(
      JSON.parse(
        await readFile(
          join(context.stateDirectory, "credential-provenance.json"),
          "utf8",
        ),
      ),
    ).toEqual({ kind: "native-authority", account: "signed-out" })
    const restarted = await context.controller.sessionApi().dispatch({
      kind: "ensure-running",
      explicit: {},
      credential: { kind: "native-saved-account" },
    })
    expect(restarted.kind).toBe("unavailable")
    expect(snapshot(context.controller).account.kind).toBe("signed-out")
  }, 15000)
})
describe("durable shared runtime", () => {
  test("manual approval is rejected before account or runtime replacement", async () => {
    const context = await native()
    await start(context.controller)
    const before = snapshot(context.controller)
    const settings = await readFile(
      join(context.homeDirectory, "settings.json"),
      "utf8",
    )
    for (const intent of [
      { kind: "update-runtime", explicit: { manualApprove: true } },
      {
        kind: "ensure-running",
        explicit: { manualApprove: true },
        credential: {
          kind: "provided-token",
          value: otherToken,
          persistence: "session",
        },
      },
    ] as const) {
      const result = await context.controller.sessionApi().dispatch(intent)
      expect(result).toMatchObject({
        kind: "unavailable",
        message:
          "Manual approval is unavailable for a gateway managed by the desktop app.",
      })
      expect(snapshot(context.controller).account).toEqual(before.account)
      expect(snapshot(context.controller).gateway).toEqual(before.gateway)
      expect(snapshot(context.controller).options).toEqual(before.options)
      expect(
        await readFile(join(context.homeDirectory, "settings.json"), "utf8"),
      ).toBe(settings)
    }
  }, 15_000)
  test("an anonymous gateway retains explicit flags and its real endpoint after native quit and CLI wake", async () => {
    const context = await native()
    await start(context.controller, {
      authentication: { kind: "none" },
      rateLimitSeconds: 0.1,
      rateLimitWait: true,
      responsesContextTrim: true,
      proxyFromEnvironment: true,
    })
    const before = snapshot(context.controller)
    const controller = await reopen(context)
    await start(controller)
    const restored = snapshot(controller)
    expect(restored.options).toEqual(before.options)
    expect(restored.authentication).toEqual({ kind: "none" })
    expect(controller.activeConnection()?.apiUrl).toBe(
      loopbackApiUrlSchema.parse(`http://127.0.0.1:${context.port}/v1`),
    )
    expect(
      (await fetch(`http://localhost:${context.port}/v1/models`)).status,
    ).toBe(200)
    const response = await post(context.port, "Check the connection", {
      signal: undefined,
      authorization: null,
    })
    expect(response.status).toBe(200)
    await response.text()
  }, 15_000)
  test("private custom keys remain encrypted and survive both controller restart and GitHub sign-out", async () => {
    const context = await native()
    const actualKey = "controller_restart_key_0123456789"
    await start(context.controller, {
      authentication: { kind: "keyed", keys: [actualKey] },
      responsesContextTrim: true,
    })
    const settings = await readFile(
      join(context.homeDirectory, "settings.json"),
      "utf8",
    )
    for (const secret of [actualKey, token, key])
      expect(settings).not.toContain(secret)
    const controller = await reopen(context)
    await start(controller)
    expect(controller.activeConnection()?.authentication).toEqual({
      kind: "keyed",
      key: actualKey,
    })
    expect(
      (
        await fetch(`http://localhost:${context.port}/v1/models`, {
          headers: { authorization: `Bearer ${actualKey}` },
        })
      ).status,
    ).toBe(200)
    await controller.sessionApi().dispatch({ kind: "sign-out" })
    expect(context.store.read()).toBeNull()
    const signedOut = await controller.sessionApi().dispatch({
      kind: "ensure-running",
      explicit: {},
      credential: { kind: "native-saved-account" },
    })
    expect(signedOut.kind).toBe("unavailable")
    await controller.dispose()
    const renewed = await createController({
      dataDirectory: context.homeDirectory,
      homeDirectory: context.homeDirectory,
      stateDirectory: context.stateDirectory,
      runtimePath,
      runtimeExecPath: "node",
      fixtureOrigin: context.remote.origin,
      platform: "darwin",
      version: "0.0.3",
      vault: context.vault,
      writeClipboard: () => {},
      openExternal: () => Promise.resolve(),
    })
    cleanups.push(() => renewed.dispose())
    const authorized = await renewed.sessionApi().dispatch({
      kind: "ensure-running",
      explicit: {},
      credential: {
        kind: "provided-token",
        value: otherToken,
        persistence: "session",
      },
    })
    expect(authorized.kind).toBe("applied")
    expect(renewed.activeConnection()?.authentication).toEqual({
      kind: "keyed",
      key: actualKey,
    })
    expect(snapshot(renewed).account).toMatchObject({
      kind: "signed-in",
      credentialSource: "session-override",
      login: "othercat",
    })
  }, 15_000)
  test("a failed durable save preserves the running gateway and saved runtime", async () => {
    const context = await native()
    await start(context.controller)
    const original = snapshot(context.controller)
    const path = join(context.homeDirectory, "settings.json")
    const backup = join(context.homeDirectory, "settings.backup.json")
    const originalSettings = await readFile(path, "utf8")
    await rename(path, backup)
    await mkdir(path)
    try {
      const result = await context.controller.sessionApi().dispatch({
        kind: "update-runtime",
        explicit: {
          port: await availablePort(),
          authentication: { kind: "none" },
        },
      })
      expect(result.kind).toBe("unavailable")
      const preserved = snapshot(context.controller)
      expect(preserved.gateway).toEqual(original.gateway)
      expect(preserved.gatewayGeneration).toBe(original.gatewayGeneration)
      expect(preserved.options).toEqual(original.options)
      expect(preserved.authentication).toEqual(original.authentication)
      expect(await readFile(backup, "utf8")).toBe(originalSettings)
      const response = await post(context.port, "Check the connection")
      expect(response.status).toBe(200)
      await response.text()
    } finally {
      await rm(path, { recursive: true, force: true })
      await rename(backup, path)
    }
  }, 15_000)
})
describe("agent configuration actions", () => {
  test("missing-only buttons preserve independent existing models and open only target folders", async () => {
    const context = await native({
      initial: async (home, port) => {
        await mkdir(join(home, ".claude"))
        await writeFile(
          join(home, ".claude/settings.json"),
          JSON.stringify(
            {
              env: {
                ANTHROPIC_BASE_URL: "http://localhost:" + String(port) + "/",
                ANTHROPIC_MODEL: "fixture-claude-sonnet[1m]",
              },
              permissions: { allow: ["Read"] },
            },
            null,
            2,
          ),
        )
        await mkdir(join(home, ".codex"))
        await writeFile(
          join(home, ".codex/config.toml"),
          '# Existing model stays\nmodel = "fixture-responses-only"\nmodel_provider = "copilot_proxy"\n[model_providers.copilot_proxy]\nbase_url = "http://localhost:'
            + String(port)
            + '/v1"\nwire_api = "responses"\n',
        )
      },
    })
    await start(context.controller, { authentication: { kind: "none" } })
    const beforeCodex = await readFile(
      join(context.homeDirectory, ".codex/config.toml"),
      "utf8",
    )
    await context.controller.invoke({
      kind: "select-agent-model",
      target: "opencode",
      modelId: "fixture-gpt-4.1",
    })
    const configured = await context.controller.invoke({
      kind: "configure-agent",
      target: "claude-code",
    })
    expect(configured.lastConfigureResult?.kind).toBe("added")
    const claude = z
      .object({
        env: z.object({
          ANTHROPIC_MODEL: z.string(),
          ANTHROPIC_BASE_URL: z.string(),
        }),
        permissions: z.object({ allow: z.array(z.string()) }),
      })
      .parse(
        JSON.parse(
          await readFile(
            join(context.homeDirectory, ".claude/settings.json"),
            "utf8",
          ),
        ),
      )
    expect(claude.env.ANTHROPIC_MODEL).toBe("fixture-claude-sonnet[1m]")
    expect(claude.env.ANTHROPIC_BASE_URL).toBe(
      "http://localhost:" + String(context.port) + "/",
    )
    expect(claude.permissions).toEqual({ allow: ["Read"] })
    expect(
      await readFile(join(context.homeDirectory, ".codex/config.toml"), "utf8"),
    ).toBe(beforeCodex)
    const openCode = await context.controller.invoke({
      kind: "configure-agent",
      target: "opencode",
    })
    expect(
      openCode.agentConfigs.find((view) => view.target === "opencode")?.model,
    ).toMatchObject({
      kind: "configured",
      exact: "copilot_proxy/fixture-gpt-4.1",
    })
    expect(
      openCode.agentConfigs.find((view) => view.target === "codex")?.model,
    ).toMatchObject({ kind: "configured", exact: "fixture-responses-only" })
    expect(
      openCode.agentConfigs.find((view) => view.target === "claude-code")
        ?.model,
    ).toMatchObject({ kind: "configured", exact: "fixture-claude-sonnet[1m]" })
    await context.controller.invoke({
      kind: "copy-config",
      target: "claude-code",
      modelId: "fixture-claude-sonnet",
      shell: "posix",
    })
    for (const target of ["claude-code", "codex", "opencode"] as const)
      await context.controller.invoke({ kind: "open-config-folder", target })
    expect(context.folders).toEqual([
      join(context.homeDirectory, ".claude"),
      join(context.homeDirectory, ".codex"),
      join(context.homeDirectory, ".config/opencode"),
    ])
  }, 15000)
})
