import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test"
import { build } from "esbuild"
import { execFileSync } from "node:child_process"
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

import type { StoredCredentials } from "../main/types"

import { upstreamCatalogSchema } from "../engine/upstream"
import { createController } from "../main/controller"
import { startFixtureUpstream } from "../testing/upstream"

const root = fileURLToPath(new URL("../../", import.meta.url))
const key = "fixture_gateway_key_012345678901234567890123456789"
const cleanups: Array<() => Promise<void>> = []
let directory = ""
let runtimePath = ""

beforeAll(async () => {
  expect(execFileSync("/sbin/mount", { encoding: "utf8" })).toContain(
    "on /Volumes/mac-ssd (",
  )
  directory = await mkdtemp(
    "/Volumes/mac-ssd/AI/projects/copilot-proxy-api--6ce38f64251a/desktop-app/refresh-order-tests-",
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
}, 30_000)

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20))
  expect(predicate()).toBe(true)
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ""
    request.setEncoding("utf8")
    request.on("data", (chunk: unknown) => {
      if (typeof chunk === "string") body += chunk
    })
    request.once("end", () => resolve(body))
    request.once("error", reject)
  })
}

async function upstreamProxy(
  options: { hideResponsesModel?: boolean; fastOAuth?: boolean } = {},
) {
  const upstream = await startFixtureUpstream()
  cleanups.push(() => upstream.close())
  let includeResponses = !options.hideResponsesModel
  const active = new Set<AbortController>()
  const handle = async (
    incoming: IncomingMessage,
    outgoing: ServerResponse,
  ) => {
    const abort = new AbortController()
    active.add(abort)
    outgoing.once("close", () => {
      abort.abort()
      active.delete(abort)
    })
    outgoing.once("finish", () => active.delete(abort))
    const headers: Record<string, string> = {}
    for (const name of ["authorization", "content-type", "accept"]) {
      const value = incoming.headers[name]
      if (typeof value === "string") headers[name] = value
    }
    const method = incoming.method ?? "GET"
    const response = await fetch(upstream.origin + (incoming.url ?? "/"), {
      method,
      headers,
      signal: abort.signal,
      ...(method === "GET" || method === "HEAD" ?
        {}
      : { body: await readBody(incoming) }),
    })
    outgoing.writeHead(response.status, {
      "content-type":
        response.headers.get("content-type") ?? "application/json",
    })
    if (incoming.url === "/models" && response.ok) {
      const catalog = upstreamCatalogSchema.parse(await response.json())
      outgoing.end(
        JSON.stringify({
          ...catalog,
          data: catalog.data.filter(
            (model) =>
              includeResponses || model.id !== "fixture-responses-only",
          ),
        }),
      )
      return
    }
    if (incoming.url === "/login/device/code" && options.fastOAuth) {
      const device = z
        .object({ interval: z.number() })
        .loose()
        .parse(await response.json())
      outgoing.end(JSON.stringify({ ...device, interval: 0.01 }))
      return
    }
    const reader = response.body?.getReader()
    if (reader) {
      while (true) {
        const result = await reader.read()
        if (result.done) break
        outgoing.write(result.value)
      }
    }
    outgoing.end()
  }
  const server = createServer((incoming, outgoing) => {
    void handle(incoming, outgoing).catch(() => outgoing.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanups.push(async () => {
    for (const abort of active) abort.abort()
    active.clear()
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  })
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("No upstream test address")
  return {
    origin: `http://127.0.0.1:${address.port}`,
    exposeResponses: () => {
      includeResponses = true
    },
  }
}

async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No test port")
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

async function native(options: { origin: string; runtimePath?: string }) {
  const dataDirectory = await mkdtemp(join(directory, "account-"))
  const port = await availablePort()
  await writeFile(
    join(dataDirectory, "settings.json"),
    JSON.stringify({ port, startOnLaunch: false }),
  )
  let stored: StoredCredentials | null = {
    githubToken: "fixture_github_token",
    gatewayKey: key,
  }
  const writes: Array<string> = []
  const clipboard: Array<string> = []
  const controller = await createController({
    dataDirectory,
    runtimePath: options.runtimePath ?? runtimePath,
    runtimeExecPath: "node",
    fixtureOrigin: options.origin,
    platform: "darwin",
    version: "0.0.1",
    vault: {
      mode: "session-only",
      load: () => Promise.resolve(stored),
      save: (credentials) => {
        writes.push("save")
        stored = structuredClone(credentials)
        return Promise.resolve()
      },
      clear: () => {
        writes.push("clear")
        stored = null
        return Promise.resolve()
      },
    },
    writeClipboard: (text) => {
      clipboard.push(text)
    },
    openExternal: () => Promise.resolve(),
  })
  cleanups.push(() => controller.dispose())
  await eventually(
    () =>
      controller.snapshot().account.kind === "signed-in"
      && controller.snapshot().modelsFetchedAt !== null,
  )
  return { controller, port, stored: () => stored, writes, clipboard }
}

describe("catalog synchronization", () => {
  test("refresh adds a Responses-only model to both the UI and live child while a stream stays connected", async () => {
    const upstream = await upstreamProxy({ hideResponsesModel: true })
    const context = await native({ origin: upstream.origin })
    await context.controller.invoke({ kind: "start-gateway" })
    const before = context.controller.snapshot().gateway
    expect(before.kind).toBe("running")
    const headers = {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    }
    const url = `http://127.0.0.1:${context.port}/v1`
    const catalog = async () =>
      z
        .object({ data: z.array(z.object({ id: z.string() })) })
        .parse(await (await fetch(url + "/models", { headers })).json()).data
    expect(
      (await catalog()).some((model) => model.id === "fixture-responses-only"),
    ).toBe(false)
    const abort = new AbortController()
    const stream = await fetch(url + "/responses", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "fixture-gpt-4.1",
        input: "fixture:long",
        stream: true,
      }),
      signal: abort.signal,
    })
    const reader = stream.body?.getReader()
    expect((await reader?.read())?.done).toBe(false)
    upstream.exposeResponses()
    const refreshed = await context.controller.invoke({ kind: "refresh" })
    expect(refreshed.notice).toBeNull()
    expect(
      refreshed.models.some((model) => model.id === "fixture-responses-only"),
    ).toBe(true)
    expect(
      (await catalog()).some((model) => model.id === "fixture-responses-only"),
    ).toBe(true)
    expect(refreshed.gateway).toEqual(before)
    expect((await reader?.read())?.done).toBe(false)
    const messages = await fetch(url + "/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "fixture-responses-only",
        max_tokens: 128,
        messages: [{ role: "user", content: "Check the connection" }],
      }),
    })
    expect(messages.status).toBe(200)
    expect(await messages.text()).toContain("Copilot Bridge is connected.")
    abort.abort()
    await reader?.cancel().catch(() => undefined)
    await context.controller.dispose()
  }, 15_000)
})

describe("native clipboard boundary", () => {
  test("copies the private local key only to native clipboard and validates agent compatibility", async () => {
    const upstream = await upstreamProxy()
    const context = await native({ origin: upstream.origin })
    await context.controller.invoke({ kind: "copy", target: "gateway-key" })
    expect(context.clipboard.at(-1)).toBe(key)
    await context.controller.invoke({
      kind: "copy-config",
      target: "codex",
      modelId: "fixture-responses-only",
      shell: "posix",
    })
    expect(context.clipboard.at(-1)).toContain(key)
    expect(context.clipboard.at(-1)).toContain("wire_api")
    expect(context.clipboard.at(-1)).not.toContain("fixture_github_token")
    const before = context.clipboard.length
    await context.controller.invoke({
      kind: "copy-config",
      target: "opencode",
      modelId: "fixture-responses-only",
      shell: "posix",
    })
    expect(context.clipboard).toHaveLength(before)
    expect(context.controller.snapshot().notice?.kind).toBe("error")
    await context.controller.invoke({
      kind: "copy-config",
      target: "codex",
      modelId: "unknown",
      shell: "posix",
    })
    expect(context.clipboard).toHaveLength(before)
    const copied = await context.controller.invoke({
      kind: "copy",
      target: "base-url",
    })
    expect(copied.notice).toBeNull()
    expect(context.clipboard.at(-1)).toBe(`http://127.0.0.1:${context.port}/v1`)
  }, 10000)
})

describe("credential write ordering", () => {
  test("a new sign-in survives sign-out while the previous child is blocked during stop", async () => {
    const upstream = await upstreamProxy({ fastOAuth: true })
    const childPath = join(directory, "blocked-child.cjs")
    await writeFile(
      childPath,
      [
        'process.on("disconnect", () => process.exit(0))',
        'process.on("SIGTERM", () => {})',
        'process.on("message", (message) => {',
        '  if (message.kind === "init") process.send({ kind: "ready" })',
        '  if (message.kind === "catalog") process.send({ kind: "catalog-updated", id: message.id })',
        "})",
      ].join("\n"),
    )
    const context = await native({
      origin: upstream.origin,
      runtimePath: childPath,
    })
    await context.controller.invoke({ kind: "start-gateway" })
    let signedOut = false
    const stopping = context.controller
      .invoke({ kind: "sign-out" })
      .then(() => {
        signedOut = true
      })
    await context.controller.invoke({ kind: "sign-in" })
    await eventually(
      () =>
        context.controller.snapshot().account.kind === "signed-in"
        && context.stored()?.gatewayKey !== key,
    )
    expect(signedOut).toBe(false)
    await stopping
    expect(context.writes).toEqual(["save", "clear", "save"])
    expect(context.stored()?.gatewayKey).not.toBe(key)
    expect(context.stored()).not.toBeNull()
    expect(context.controller.snapshot().account.kind).toBe("signed-in")
  }, 10_000)
})
