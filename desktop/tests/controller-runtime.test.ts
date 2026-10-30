import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test"
import { build } from "esbuild"
import { execFileSync, fork } from "node:child_process"
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { createServer, request as httpRequest } from "node:http"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

import type {
  CredentialVault,
  DesktopController,
  StoredCredentials,
} from "../main/types"
import type {
  ActivityRecord,
  DesktopSettings,
  DesktopSnapshot,
} from "../shared/contracts"

import { createController } from "../main/controller"
import { startProxyProcess } from "../main/proxy-process"
import { snapshotSchema } from "../shared/contracts"
import { startFixtureUpstream } from "../testing/upstream"
const root = fileURLToPath(new URL("../../", import.meta.url))
const cleanups: Array<() => Promise<void>> = []
let directory = ""
let runtimePath = ""
const gatewayKey = "fixture_gateway_key_012345678901234567890123456789"
beforeAll(async () => {
  expect(execFileSync("/sbin/mount", { encoding: "utf8" })).toContain(
    "on /Volumes/mac-ssd (",
  )
  directory = await mkdtemp(
    "/Volumes/mac-ssd/AI/projects/copilot-proxy-api--6ce38f64251a/desktop-app/runtime-tests-",
  )
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
async function eventually(
  predicate: () => boolean,
  timeout = 8000,
): Promise<void> {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  expect(predicate()).toBe(true)
}
async function expectRejection(task: Promise<unknown>): Promise<void> {
  let rejected = false
  try {
    await task
  } catch {
    rejected = true
  }
  expect(rejected).toBe(true)
}
async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No test port")
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}
async function fixture() {
  const upstream = await startFixtureUpstream()
  cleanups.push(() => upstream.close())
  return upstream
}
async function proxy() {
  const upstream = await fixture()
  const port = await availablePort()
  const activity: Array<ActivityRecord> = []
  const process = startProxyProcess({
    runtimePath,
    runtimeExecPath: "node",
    init: {
      kind: "init",
      githubToken: "fixture_github_token",
      gatewayKey,
      port,
      accountType: "individual",
      fixtureOrigin: upstream.origin,
    },
    onActivity: (record) => activity.push(record),
    onExit: () => undefined,
  })
  cleanups.push(() => process.stop())
  await process.ready
  const origin = `http://127.0.0.1:${port}`
  const headers = {
    authorization: `Bearer ${gatewayKey}`,
    "content-type": "application/json",
  }
  return { upstream, port, activity, process, origin, headers }
}
async function rawStatus(
  origin: string,
  headers: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL("/v1/models", origin)
    const request = httpRequest(url, { headers }, (response) => {
      response.resume().once("end", () => resolve(response.statusCode ?? 0))
    })
    request.once("error", reject)
    request.end()
  })
}
function memoryVault(initial: StoredCredentials | null = null) {
  let stored = initial
  const vault: CredentialVault = {
    mode: "session-only",
    load: () => Promise.resolve(stored),
    save: (value) => {
      stored = structuredClone(value)
      return Promise.resolve()
    },
    clear: () => {
      stored = null
      return Promise.resolve()
    },
  }
  return { vault, read: () => stored }
}
async function controller(
  options: {
    restore?: boolean
    settings?: Partial<DesktopSettings>
    vault?: CredentialVault
  } = {},
) {
  const upstream = await fixture()
  const port = await availablePort()
  const dataDirectory = await mkdtemp(join(directory, "account-"))
  await writeFile(
    join(dataDirectory, "settings.json"),
    JSON.stringify({ port, startOnLaunch: false, ...options.settings }),
  )
  const store = memoryVault(
    options.restore ?
      { githubToken: "fixture_github_token", gatewayKey }
    : null,
  )
  const clipboard: Array<string> = []
  const opened: Array<string> = []
  const loginItems: Array<boolean> = []
  const native = await createController({
    dataDirectory,
    runtimePath,
    runtimeExecPath: "node",
    fixtureOrigin: upstream.origin,
    platform: "darwin",
    version: "0.0.1",
    vault: options.vault ?? store.vault,
    writeClipboard: (text) => {
      clipboard.push(text)
    },
    openExternal: (url) => {
      opened.push(url)
      return Promise.resolve()
    },
    applyLoginItem: (enabled) => {
      loginItems.push(enabled)
      return Promise.resolve()
    },
  })
  cleanups.push(() => native.dispose())
  if (options.restore)
    await eventually(
      () =>
        native.snapshot().account.kind === "signed-in"
        && native.snapshot().modelsFetchedAt !== null,
    )
  return {
    native,
    upstream,
    dataDirectory,
    port,
    store,
    clipboard,
    opened,
    loginItems,
  }
}
function validSnapshot(native: DesktopController): DesktopSnapshot {
  const result = snapshotSchema.parse(native.snapshot())
  const serialized = JSON.stringify(result)
  expect(serialized).not.toContain("fixture_github_token")
  expect(serialized).not.toContain("fixture_copilot_token")
  expect(serialized).not.toContain(gatewayKey)
  return result
}
describe("desktop proxy child", () => {
  test("requires a key on every route, rejects browser origins and hosts, and omits credential routes", async () => {
    const runtime = await proxy()
    for (const path of ["/", "/v1/models", "/token", "/debug", "/usage"]) {
      const response = await fetch(runtime.origin + path)
      expect(response.status).toBe(401)
      await response.text()
    }
    expect(
      await rawStatus(runtime.origin, {
        host: "evil.test",
        authorization: `Bearer ${gatewayKey}`,
      }),
    ).toBe(403)
    for (const origin of [
      "null",
      "http://127.0.0.1:4141",
      "https://example.test",
    ]) {
      expect(
        (
          await fetch(`${runtime.origin}/v1/models`, {
            headers: { ...runtime.headers, origin },
          })
        ).status,
      ).toBe(403)
    }
    for (const keys of [
      { authorization: "Bearer wrong", "x-api-key": gatewayKey },
      { authorization: `Bearer ${gatewayKey}`, "x-api-key": "wrong" },
      { authorization: "Basic wrong", "x-api-key": gatewayKey },
    ])
      expect(
        (await fetch(`${runtime.origin}/v1/models`, { headers: keys })).status,
      ).toBe(401)
    expect(
      (
        await fetch(`${runtime.origin}/v1/models`, {
          headers: { "x-api-key": gatewayKey },
        })
      ).status,
    ).toBe(200)
    for (const path of [
      "/token",
      "/debug",
      "/usage",
      "/v1/token",
      "/v1/debug",
    ]) {
      const response = await fetch(runtime.origin + path, {
        headers: runtime.headers,
      })
      expect(response.status).toBe(404)
      expect(await response.text()).not.toContain("fixture_")
    }
  }, 15000)
  test("preserves buffered Chat, Responses, and Messages through an actual Node POST listener", async () => {
    const runtime = await proxy()
    const cases = [
      {
        path: "/v1/chat/completions",
        body: {
          model: "fixture-gpt-4.1",
          messages: [{ role: "user", content: "Check the connection" }],
        },
        expected: "choices",
      },
      {
        path: "/v1/responses",
        body: {
          model: "fixture-responses-only",
          input: "Check the connection",
        },
        expected: "output",
      },
      {
        path: "/v1/messages",
        body: {
          model: "fixture-claude-sonnet",
          max_tokens: 128,
          messages: [{ role: "user", content: "Check the connection" }],
        },
        expected: "content",
      },
    ]
    for (const request of cases) {
      const response = await fetch(runtime.origin + request.path, {
        method: "POST",
        headers: runtime.headers,
        body: JSON.stringify(request.body),
      })
      const reply: unknown = await response.json()
      expect(response.status).toBe(200)
      expect(reply).toHaveProperty(request.expected)
      expect(JSON.stringify(reply)).toContain("Copilot Bridge is connected.")
    }
    await eventually(() => runtime.activity.length === 3)
    expect(
      runtime.activity.every((record) => record.outcome === "completed"),
    ).toBe(true)
    expect(runtime.activity.map((record) => record.inputTokens)).toEqual([
      37, 37, 37,
    ])
    expect(runtime.activity.map((record) => record.cachedTokens)).toEqual([
      5, 5, 5,
    ])
    expect(JSON.stringify(runtime.activity)).not.toContain(
      "Check the connection",
    )
    expect(JSON.stringify(runtime.activity)).not.toContain(
      "Copilot Bridge is connected.",
    )
    await runtime.process.stop()
    await runtime.process.stop()
    await expectRejection(fetch(runtime.origin))
  }, 15000)
})
describe("desktop streaming and parent shutdown", () => {
  test("records final stream usage, failed upstreams, and real client cancellation", async () => {
    const runtime = await proxy()
    const post = (body: object, signal?: AbortSignal) =>
      fetch(`${runtime.origin}/v1/responses`, {
        method: "POST",
        headers: runtime.headers,
        body: JSON.stringify(body),
        signal,
      })
    const stream = await post({
      model: "fixture-responses-only",
      input: "Check the connection",
      stream: true,
    })
    expect(await stream.text()).toContain("response.completed")
    await eventually(() => runtime.activity.length === 1)
    expect(runtime.activity[0]).toMatchObject({
      outcome: "completed",
      inputTokens: 37,
      outputTokens: 9,
      cachedTokens: 5,
    })
    const failed = await post({
      model: "fixture-responses-only",
      input: "fixture:fail",
    })
    expect(failed.status).toBe(503)
    await failed.text()
    await eventually(() => runtime.activity.length === 2)
    expect(runtime.activity[1]).toMatchObject({
      outcome: "failed",
      status: 503,
    })
    const abort = new AbortController()
    const slow = await post(
      { model: "fixture-responses-only", input: "fixture:long", stream: true },
      abort.signal,
    )
    const reader = slow.body?.getReader()
    expect((await reader?.read())?.done).toBe(false)
    abort.abort()
    await reader?.cancel().catch(() => undefined)
    await eventually(() => runtime.activity.length === 3)
    expect(runtime.activity[2]?.outcome).toBe("cancelled")
    expect(JSON.stringify(runtime.activity)).not.toContain("fixture_failure")
    const interrupted = await post({
      model: "fixture-responses-only",
      input: "fixture:long",
      stream: true,
    })
    const active = interrupted.body?.getReader()
    expect((await active?.read())?.done).toBe(false)
    await runtime.process.stop()
    await active?.cancel().catch(() => undefined)
    await eventually(() => runtime.activity.length === 4)
    expect(runtime.activity[3]?.outcome).toBe("cancelled")
    await expectRejection(fetch(runtime.origin))
  }, 20000)
  test("Chat and Messages streaming retain their wire format and final usage", async () => {
    const runtime = await proxy()
    for (const protocol of ["chat/completions", "messages"]) {
      const response = await fetch(`${runtime.origin}/v1/${protocol}`, {
        method: "POST",
        headers: runtime.headers,
        body: JSON.stringify({
          model: "fixture-gpt-4.1",
          max_tokens: 128,
          stream: true,
          messages: [{ role: "user", content: "Check the connection" }],
        }),
      })
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain(
        "text/event-stream",
      )
      const text = await response.text()
      expect(text).toContain(
        protocol === "messages" ? "message_stop" : "[DONE]",
      )
      if (protocol === "messages") {
        const schema = z.object({
          type: z.literal("message_delta"),
          usage: z.object({
            input_tokens: z.number(),
            output_tokens: z.number(),
            cache_read_input_tokens: z.number(),
          }),
        })
        const usage = text
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .flatMap((line) => {
            const parsed = schema.safeParse(
              JSON.parse(line.slice(6)) as unknown,
            )
            return parsed.success ? [parsed.data.usage] : []
          })
        expect(usage).toEqual([
          { input_tokens: 32, output_tokens: 9, cache_read_input_tokens: 5 },
        ])
      }
    }
    await eventually(() => runtime.activity.length === 2)
    expect(
      runtime.activity.every((record) => record.outcome === "completed"),
    ).toBe(true)
    expect(runtime.activity.map((record) => record.inputTokens)).toEqual([
      37, 37,
    ])
    expect(runtime.activity.map((record) => record.outputTokens)).toEqual([
      9, 9,
    ])
  }, 15000)
  test("parent death closes the orphaned listener", async () => {
    const upstream = await fixture()
    const port = await availablePort()
    const parentPath = join(directory, "parent.cjs")
    await writeFile(
      parentPath,
      [
        'const { fork } = require("node:child_process")',
        'const child = fork(process.argv[2], [], { execPath: process.execPath, execArgv: [], env: {}, stdio: ["ignore", "ignore", "ignore", "ipc"] })',
        'child.on("message", (event) => { if (event.kind === "ready") process.send({ kind: "ready" }) })',
        'process.on("message", (init) => child.send(init))',
        "setInterval(() => {}, 1000)",
      ].join("\n"),
    )
    const init = {
      kind: "init",
      githubToken: "fixture_github_token",
      gatewayKey,
      port,
      accountType: "individual",
      fixtureOrigin: upstream.origin,
    }
    const parent = fork(parentPath, [runtimePath], {
      execPath: "node",
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    })
    cleanups.push(() => {
      parent.kill("SIGKILL")
      return Promise.resolve()
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Parent startup timed out")),
        10000,
      )
      parent.once("message", () => {
        clearTimeout(timer)
        resolve()
      })
      parent.once("spawn", () => parent.send(init))
      parent.once("error", reject)
    })
    expect(
      (
        await fetch(`http://127.0.0.1:${port}/v1/models`, {
          headers: { authorization: `Bearer ${gatewayKey}` },
        })
      ).status,
    ).toBe(200)
    parent.kill("SIGKILL")
    let closed = false
    const deadline = Date.now() + 5000
    while (!closed && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 30))
      try {
        await fetch(`http://127.0.0.1:${port}/`)
      } catch {
        closed = true
      }
    }
    expect(closed).toBe(true)
  }, 15000)
})
describe("native desktop controller", () => {
  test("sign-in and cancellation return promptly and stale approval never restores an account", async () => {
    const context = await controller()
    const connecting = await context.native.invoke({ kind: "sign-in" })
    expect(connecting.account.kind).toBe("connecting")
    await eventually(
      () => context.native.snapshot().account.kind === "awaiting-authorization",
    )
    await context.native.invoke({ kind: "open-device-page" })
    expect(context.opened).toEqual(["https://github.com/login/device"])
    await context.native.invoke({ kind: "copy", target: "device-code" })
    expect(context.clipboard.at(-1)).toMatch(/^BRDG-\d{4}$/)
    const cancelled = await context.native.invoke({ kind: "cancel-sign-in" })
    expect(cancelled.account.kind).toBe("signed-out")
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect(validSnapshot(context.native).account.kind).toBe("signed-out")
    expect(context.store.read()).toBeNull()
  }, 10000)
  test("approved login discovers actual models and quota without starting when disabled", async () => {
    const context = await controller()
    await context.native.invoke({ kind: "sign-in" })
    await eventually(
      () =>
        context.native.snapshot().account.kind === "signed-in"
        && context.native.snapshot().modelsFetchedAt !== null,
    )
    const result = validSnapshot(context.native)
    expect(result.account).toMatchObject({
      kind: "signed-in",
      login: "octocat",
      name: "Mona",
    })
    expect(
      result.models.some((model) => model.id === "fixture-responses-only"),
    ).toBe(true)
    expect(result.usage?.quotas).toContainEqual({
      kind: "unlimited",
      id: "chat",
      label: "Chat",
    })
    expect(result.gateway.kind).toBe("stopped")
    expect(context.store.read()?.gatewayKey).toHaveLength(43)
    await context.native.invoke({
      kind: "select-model",
      modelId: "fixture-responses-only",
    })
    const persisted: unknown = JSON.parse(
      await readFile(join(context.dataDirectory, "settings.json"), "utf8"),
    )
    expect(persisted).toHaveProperty("preferredModel", "fixture-responses-only")
    const tampered = context.native.snapshot()
    tampered.settings.port = 1
    tampered.models.splice(0)
    expect(validSnapshot(context.native).settings.port).toBe(context.port)
    expect(context.native.snapshot().models.length).toBeGreaterThan(0)
  }, 10000)
  test("repeated lifecycle commands, rotation, probes, settings restart, and sign-out converge", async () => {
    const context = await controller({ restore: true })
    await Promise.all([
      context.native.invoke({ kind: "start-gateway" }),
      context.native.invoke({ kind: "start-gateway" }),
    ])
    expect(validSnapshot(context.native).gateway.kind).toBe("running")
    await context.native.invoke({
      kind: "run-probe",
      modelId: "fixture-responses-only",
      prompt: "Check the connection",
    })
    await eventually(() => context.native.snapshot().probe.kind === "complete")
    expect(context.native.snapshot().probe).toMatchObject({
      kind: "complete",
      text: "Copilot Bridge is connected.",
    })
    await eventually(() => context.native.snapshot().activity.length === 1)
    expect(context.native.snapshot().totals).toMatchObject({
      requests: 1,
      inputTokens: 37,
      outputTokens: 9,
      cachedTokens: 5,
    })
    await context.native.invoke({ kind: "rotate-key" })
    expect(context.store.read()?.gatewayKey).not.toBe(gatewayKey)
    const old = await fetch(`http://127.0.0.1:${context.port}/v1/models`, {
      headers: { authorization: `Bearer ${gatewayKey}` },
    })
    expect(old.status).toBe(401)
    const nextPort = await availablePort()
    const nextSettings = {
      ...context.native.snapshot().settings,
      port: nextPort,
      accountType: "business",
      launchAtLogin: true,
    }
    await context.native.invoke({
      kind: "save-settings",
      settings: nextSettings,
    })
    expect(context.loginItems).toEqual([true])
    expect(context.native.snapshot().gateway).toMatchObject({
      kind: "running",
      url: `http://127.0.0.1:${nextPort}/v1`,
    })
    await expectRejection(fetch(`http://127.0.0.1:${context.port}/`))
    await context.native.invoke({ kind: "sign-out" })
    const result = validSnapshot(context.native)
    expect(result.account.kind).toBe("signed-out")
    expect(result.gateway.kind).toBe("stopped")
    expect(result.models).toEqual([])
    expect(result.usage).toBeNull()
    expect(result.activity).toEqual([])
    expect(context.store.read()).toBeNull()
    await expectRejection(fetch(`http://127.0.0.1:${nextPort}/`))
  }, 20000)
})
describe("desktop lifecycle, history and persistence", () => {
  test("a busy port is actionable, stopped starts can be cancelled, and disposal closes the listener", async () => {
    const context = await controller({ restore: true })
    const busy = createServer()
    await new Promise<void>((resolve) =>
      busy.listen(context.port, "127.0.0.1", resolve),
    )
    cleanups.push(
      () => new Promise<void>((resolve) => busy.close(() => resolve())),
    )
    await context.native.invoke({ kind: "start-gateway" })
    const failed = context.native.snapshot().gateway
    expect(failed.kind).toBe("error")
    if (failed.kind === "error")
      expect(failed.message).toContain("port is already in use")
    await new Promise<void>((resolve) => busy.close(() => resolve()))
    await Promise.all([
      context.native.invoke({ kind: "stop-gateway" }),
      context.native.invoke({ kind: "start-gateway" }),
    ])
    expect(context.native.snapshot().gateway.kind).toBe("running")
    await context.native.invoke({ kind: "stop-gateway" })
    await Promise.all([
      context.native.invoke({ kind: "start-gateway" }),
      context.native.invoke({ kind: "stop-gateway" }),
    ])
    expect(context.native.snapshot().gateway.kind).toBe("stopped")
    await context.native.invoke({ kind: "start-gateway" })
    expect(context.native.snapshot().gateway.kind).toBe("running")
    const previous = context.native.snapshot().gateway
    await Promise.all([
      context.native.invoke({ kind: "stop-gateway" }),
      context.native.invoke({ kind: "start-gateway" }),
    ])
    const restarted = context.native.snapshot().gateway
    expect(restarted.kind).toBe("running")
    if (previous.kind === "running" && restarted.kind === "running")
      expect(restarted.startedAt).not.toBe(previous.startedAt)
    const available = await fetch(
      `http://127.0.0.1:${context.port}/v1/models`,
      { headers: { authorization: `Bearer ${gatewayKey}` } },
    )
    expect(available.status).toBe(200)
    await available.text()
    await context.native.dispose()
    await context.native.dispose()
    await expectRejection(fetch(`http://127.0.0.1:${context.port}/`))
  }, 20000)
  test("refresh failure preserves prior data and invalid commands never reach privileged adapters", async () => {
    const context = await controller({ restore: true })
    const previous = validSnapshot(context.native)
    await context.upstream.close()
    await context.native.invoke({ kind: "refresh" })
    const result = validSnapshot(context.native)
    expect(result.models).toEqual(previous.models)
    expect(result.modelsFetchedAt).toBe(previous.modelsFetchedAt)
    expect(result.usage).toEqual(previous.usage)
    expect(result.notice?.kind).toBe("error")
    await context.native.invoke({
      kind: "open-device-page",
      url: "https://evil.test",
    })
    expect(context.opened).toEqual([])
    await context.native.invoke({
      kind: "save-settings",
      settings: { ...result.settings, port: 1 },
    })
    expect(context.native.snapshot().settings.port).toBe(context.port)
    expect(context.loginItems).toEqual([])
  }, 10000)
  test("session history remains bounded while totals keep accumulating and clear preserves totals", async () => {
    const context = await controller({ restore: true })
    await context.native.invoke({ kind: "start-gateway" })
    for (let batch = 0; batch < 7; batch++) {
      await Promise.all(
        Array.from({ length: 30 }, () =>
          fetch(`http://127.0.0.1:${context.port}/v1/models`, {
            headers: { authorization: `Bearer ${gatewayKey}` },
          }).then((response) => response.text()),
        ),
      )
    }
    await eventually(() => context.native.snapshot().totals.requests === 210)
    expect(context.native.snapshot().activity).toHaveLength(200)
    await context.native.invoke({ kind: "clear-activity" })
    expect(context.native.snapshot().activity).toEqual([])
    expect(context.native.snapshot().totals.requests).toBe(210)
  }, 15000)
  test("sign-out during credential persistence wins over the late authorization", async () => {
    const store = memoryVault()
    const saving = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const vault: CredentialVault = {
      ...store.vault,
      async save(value) {
        saving.resolve(undefined)
        await release.promise
        await store.vault.save(value)
      },
    }
    const context = await controller({ vault })
    await context.native.invoke({ kind: "sign-in" })
    await saving.promise
    const signedOut = context.native.invoke({ kind: "sign-out" })
    release.resolve(undefined)
    await signedOut
    expect(store.read()).toBeNull()
    expect(validSnapshot(context.native).account.kind).toBe("signed-out")
    expect(context.native.snapshot().gateway.kind).toBe("stopped")
  }, 10000)
})

describe("desktop command results and startup intent", () => {
  test("an explicit stop during sign-in takes precedence over automatic startup", async () => {
    const context = await controller({ settings: { startOnLaunch: true } })
    let requested = false
    const stopped = Promise.withResolvers<undefined>()
    const unsubscribe = context.native.subscribe((snapshot) => {
      if (snapshot.account.kind !== "signed-in" || requested) return
      requested = true
      void context.native
        .invoke({ kind: "stop-gateway" })
        .then(() => stopped.resolve(undefined))
    })
    await context.native.invoke({ kind: "sign-in" })
    await stopped.promise
    await eventually(() => context.native.snapshot().modelsFetchedAt !== null)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(validSnapshot(context.native).gateway.kind).toBe("stopped")
    await expectRejection(fetch(`http://127.0.0.1:${context.port}/`))
    unsubscribe()
  }, 10000)
})
