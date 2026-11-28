import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test"
import { build } from "esbuild"
import { fork } from "node:child_process"
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import type { NativeConnection } from "../../../src/lib/proxy-contracts"
import type { ActivityRecord, DesktopModel } from "../shared/contracts"

import { nativeConnectionSchema } from "../../../src/lib/proxy-contracts"
import {
  createAccountClient,
  toDesktopModel,
  upstreamCatalogSchema,
  UpstreamError,
} from "../engine/upstream"
import { signInError } from "../main/failure-messages"
import { authorizeDevice, DeviceFlowError } from "../main/oauth"
import { executeProbe } from "../main/probe"
import {
  ProxyProcessError,
  type ProxyExitReason,
  startProxyProcess,
} from "../main/proxy-process"
import { startFixtureUpstream } from "../testing/upstream"
import { availablePort } from "./fixtures/runtime"

const root = fileURLToPath(new URL("../../../", import.meta.url))
const gatewayKey = "fixture_gateway_key_012345678901234567890123456789"
const cleanups: Array<() => Promise<void>> = []
let engineDirectory = ""
let engineRuntimePath = ""

beforeAll(async () => {
  engineDirectory = await mkdtemp(join(tmpdir(), "copilot-proxy-oauth-tests-"))
  engineRuntimePath = join(engineDirectory, "engine.cjs")
  await symlink(
    await realpath(join(root, "desktop-rust/bridge/node_modules")),
    join(engineDirectory, "node_modules"),
  )
  await build({
    entryPoints: [join(root, "desktop-rust/bridge/engine/index.ts")],
    outfile: engineRuntimePath,
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
  if (engineDirectory)
    await rm(engineDirectory, { recursive: true, force: true })
})
async function fixture() {
  const upstream = await startFixtureUpstream()
  cleanups.push(() => upstream.close())
  return upstream
}
async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20))
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
describe("bounded device authorization", () => {
  test("denied and expired grants terminate with explicit safe outcomes", async () => {
    for (const mode of ["denied", "expired"] as const) {
      const upstream = await fixture()
      upstream.setOAuthMode(mode)
      const task = authorizeDevice({
        fixtureOrigin: upstream.origin,
        signal: new AbortController().signal,
        onCode: () => undefined,
      })
      try {
        await task
        throw new Error("Expected device authorization failure")
      } catch (error) {
        expect(error).toBeInstanceOf(DeviceFlowError)
        expect(error instanceof DeviceFlowError ? error.kind : "unknown").toBe(
          mode,
        )
      }
    }
  }, 10000)
  test("slow_down postpones further polling and cancellation ends the wait", async () => {
    const upstream = await fixture()
    upstream.setOAuthMode("slow")
    const abort = new AbortController()
    const task = authorizeDevice({
      fixtureOrigin: upstream.origin,
      signal: abort.signal,
      onCode: () => undefined,
    })
    await eventually(() => upstream.metrics.requests === 2)
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(upstream.metrics.requests).toBe(2)
    abort.abort()
    await expectRejection(task)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(upstream.metrics.requests).toBe(2)
  }, 8000)
  test("device expiry stops a pending poll even when the network does not respond", async () => {
    let polls = 0
    const server = createServer((request, response) => {
      request.resume()
      if (request.url === "/login/device/code") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            device_code: "fixture-expiring",
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            expires_in: 0.15,
            interval: 0.02,
          }),
        )
      } else polls++
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    cleanups.push(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    const address = server.address()
    if (!address || typeof address === "string")
      throw new Error("No expiry fixture port")
    const task = authorizeDevice({
      fixtureOrigin: `http://127.0.0.1:${address.port}`,
      signal: new AbortController().signal,
      onCode: () => undefined,
    })
    try {
      await task
      throw new Error("Expected device expiry")
    } catch (error) {
      expect(error).toBeInstanceOf(DeviceFlowError)
      expect(error instanceof DeviceFlowError ? error.kind : "unknown").toBe(
        "expired",
      )
    }
    expect(polls).toBe(1)
  }, 5000)
  test("an untrusted device URL never becomes an authorization page", async () => {
    const server = createServer((request, response) => {
      request.resume()
      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          device_code: "fixture-untrusted",
          user_code: "ABCD-EFGH",
          verification_uri: "https://github.com.evil.test/login/device",
          expires_in: 10,
          interval: 1,
        }),
      )
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    )
    const address = server.address()
    if (!address || typeof address === "string")
      throw new Error("No device URL fixture port")
    let showedCode = false
    await expectRejection(
      authorizeDevice({
        fixtureOrigin: `http://127.0.0.1:${address.port}`,
        signal: new AbortController().signal,
        onCode: () => {
          showedCode = true
        },
      }),
    )
    expect(showedCode).toBe(false)
  })
})

describe("device authorization retry resilience", () => {
  test("transient network and 503 poll errors retry and succeed on recovery", async () => {
    let polls = 0
    const server = createServer((request, response) => {
      request.resume()
      if (request.url === "/login/device/code") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            device_code: "fixture-transient",
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            expires_in: 10,
            interval: 0.02,
          }),
        )
        return
      }
      polls++
      if (polls === 1) {
        response.writeHead(503, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: "temporarily_unavailable" }))
        return
      }
      if (polls === 2) {
        request.socket.destroy()
        return
      }
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ access_token: "gho_recovered_token" }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    cleanups.push(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    const address = server.address()
    if (!address || typeof address === "string")
      throw new Error("No transient fixture port")
    const token = await authorizeDevice({
      fixtureOrigin: `http://127.0.0.1:${address.port}`,
      signal: new AbortController().signal,
      onCode: () => undefined,
    })
    expect(token).toBe("gho_recovered_token")
    expect(polls).toBe(3)
  }, 5000)
  test("consecutive transient poll failures abort once the retry budget is exhausted", async () => {
    let polls = 0
    const server = createServer((request, response) => {
      request.resume()
      if (request.url === "/login/device/code") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            device_code: "fixture-persistent-503",
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            expires_in: 30,
            interval: 0.01,
          }),
        )
        return
      }
      polls++
      response.writeHead(503, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: "service_unavailable" }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    cleanups.push(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    const address = server.address()
    if (!address || typeof address === "string")
      throw new Error("No persistent-503 fixture port")
    try {
      await authorizeDevice({
        fixtureOrigin: `http://127.0.0.1:${address.port}`,
        signal: new AbortController().signal,
        onCode: () => undefined,
      })
      throw new Error("Expected persistent 503 failure")
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamError)
      expect(error instanceof UpstreamError ? error.kind : "unknown").toBe(
        "unavailable",
      )
    }
    expect(polls).toBe(5)
  }, 5000)
})

describe("upstream catalog and usage resilience", () => {
  test("preserves vision limits, slash IDs, and model type while skipping malformed entries", () => {
    const parsed = upstreamCatalogSchema.parse({
      object: "list",
      data: [
        {
          id: "openai/gpt-4.1",
          name: "GPT-4.1",
          vendor: "OpenAI",
          supported_endpoints: null,
          policy: { state: "enabled", terms: null },
          capabilities: {
            type: "chat",
            limits: {
              max_context_window_tokens: 128_000,
              max_output_tokens: 16_384,
              max_inputs: null,
              vision: {
                max_prompt_image_size: 5_242_880,
                max_prompt_images: 10,
                supported_media_types: ["image/png", "image/jpeg"],
              },
            },
            supports: {
              tool_calls: true,
              vision: true,
              streaming: true,
              reasoning_effort: null,
            },
          },
        },
        {
          id: "bad id with spaces!",
          name: 42,
          capabilities: null,
        },
        {
          id: "text-embedding-3-small",
          name: "Embeddings",
          vendor: null,
          policy: null,
          capabilities: {
            type: "embeddings",
            limits: null,
            supports: null,
          },
        },
      ],
    })
    expect(parsed.data).toHaveLength(2)
    const [firstModel, secondModel] = parsed.data
    expect(firstModel.id).toBe("openai/gpt-4.1")
    expect(firstModel.capabilities.limits.vision).toEqual({
      max_prompt_image_size: 5_242_880,
      max_prompt_images: 10,
      supported_media_types: ["image/png", "image/jpeg"],
    })
    expect(firstModel.policy).toEqual({ state: "enabled", terms: "" })
    const chatModel = toDesktopModel(firstModel)
    const embedModel = toDesktopModel(secondModel)
    expect(chatModel.type).toBe("chat")
    expect(embedModel.type).toBe("embeddings")
    expect(() =>
      upstreamCatalogSchema.parse({ object: "list", data: [{ broken: true }] }),
    ).toThrow()
    expect(() =>
      upstreamCatalogSchema.parse({ object: "list", data: "not-an-array" }),
    ).toThrow()
  })

  test("usage tolerates nullish fields, negative entitlement, and malformed snapshots", async () => {
    const server = createServer((request, response) => {
      request.resume()
      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          copilot_plan: null,
          quota_reset_date: null,
          quota_snapshots: {
            chat: {
              entitlement: -1,
              remaining: null,
              percent_remaining: null,
              unlimited: true,
            },
            broken_entry: "invalid",
            null_entry: null,
            premium_interactions: {
              entitlement: 300,
              remaining: 240,
              percent_remaining: null,
              unlimited: null,
            },
          },
        }),
      )
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    )
    const address = server.address()
    if (!address || typeof address === "string")
      throw new Error("No usage fixture port")
    const client = createAccountClient({
      githubToken: "fixture_github_token",
      accountType: "individual",
      fixtureOrigin: `http://127.0.0.1:${address.port}`,
      signal: new AbortController().signal,
    })
    const usage = await client.usage()
    expect(usage.plan).toBe("Copilot")
    expect(usage.resetAt).toBeNull()
    expect(usage.quotas).toEqual([
      { kind: "unlimited", id: "chat", label: "Chat" },
      {
        kind: "limited",
        id: "premium_interactions",
        label: "Premium requests",
        remaining: 240,
        limit: 300,
        percentRemaining: 80,
      },
    ])
  })
})

describe("probe response parsing", () => {
  test("falls past empty output_text and ignores null reasoning content items", async () => {
    const server = createServer((request, response) => {
      request.resume()
      response.writeHead(200, { "content-type": "application/json" })
      if (request.url === "/v1/responses") {
        response.end(
          JSON.stringify({
            output_text: "",
            output: [
              { type: "reasoning", content: null },
              {
                type: "message",
                content: [
                  { type: "refusal", text: null },
                  { type: "output_text", text: "Answer from output items" },
                ],
              },
            ],
          }),
        )
        return
      }
      response.end(
        JSON.stringify({
          output_text: "",
          choices: [{ message: { content: "Answer from choices" } }],
        }),
      )
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    )
    const address = server.address()
    if (!address || typeof address === "string")
      throw new Error("No probe fixture port")
    const connection: NativeConnection = nativeConnectionSchema.parse({
      rootUrl: `http://127.0.0.1:${address.port}/`,
      apiUrl: `http://127.0.0.1:${address.port}/v1`,
      authentication: { kind: "none" },
    })
    const baseModel: Omit<DesktopModel, "endpoints"> = {
      id: "probe-model",
      name: "Probe Model",
      vendor: "OpenAI",
      contextWindow: 128_000,
      maxOutput: 16_384,
      supports: [],
      preview: false,
    }
    const responsesProbe = await executeProbe({
      connection,
      model: { ...baseModel, endpoints: ["/responses"] },
      prompt: "Ping",
      signal: new AbortController().signal,
    })
    expect(responsesProbe.text).toBe("Answer from output items")
    const chatProbe = await executeProbe({
      connection,
      model: { ...baseModel, endpoints: ["/chat/completions"] },
      prompt: "Ping",
      signal: new AbortController().signal,
    })
    expect(chatProbe.text).toBe("Answer from choices")
  })

  test("routes Google chat models to /v1beta/models/:generateContent with x-goog-api-key and skips thought parts", async () => {
    const requests: Array<{
      url: string
      googleKey: string | undefined
      authorization: string | undefined
      body: unknown
    }> = []
    let thoughtOnly = false
    const server = createServer((request, response) => {
      const chunks: Array<Buffer> = []
      request.on("data", (chunk: Buffer) => chunks.push(chunk))
      request.on("end", () => {
        requests.push({
          url: request.url ?? "",
          googleKey: request.headers["x-goog-api-key"] as string | undefined,
          authorization: request.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        })
        response.writeHead(200, { "content-type": "application/json" })
        const parts =
          thoughtOnly ?
            [{ text: "internal reasoning", thought: true }]
          : [
              { text: "internal reasoning", thought: true },
              { text: null, thought: false },
              { text: "  Hello from " },
              { text: "Gemini!  " },
            ]
        response.end(JSON.stringify({ candidates: [{ content: { parts } }] }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    )
    const address = server.address()
    if (!address || typeof address === "string")
      throw new Error("No Gemini probe fixture port")
    const keyedConnection = nativeConnectionSchema.parse({
      rootUrl: `http://127.0.0.1:${address.port}/`,
      apiUrl: `http://127.0.0.1:${address.port}/v1`,
      authentication: { kind: "keyed", key: gatewayKey },
    })
    const googleModel: DesktopModel = {
      id: "gemini-2.5-pro",
      name: "Gemini 2.5 Pro",
      vendor: "Google",
      type: "chat",
      contextWindow: 1_000_000,
      maxOutput: 65_536,
      supports: ["streaming", "tools"],
      endpoints: ["/chat/completions"],
      preview: false,
    }
    const result = await executeProbe({
      connection: keyedConnection,
      model: googleModel,
      prompt: "Ping Gemini",
      signal: new AbortController().signal,
    })
    expect(result.text).toBe("Hello from Gemini!")
    expect(requests).toEqual([
      {
        url: "/v1beta/models/gemini-2.5-pro:generateContent",
        googleKey: gatewayKey,
        authorization: undefined,
        body: {
          contents: [{ role: "user", parts: [{ text: "Ping Gemini" }] }],
          generationConfig: { maxOutputTokens: 128 },
        },
      },
    ])
    thoughtOnly = true
    await expectRejection(
      executeProbe({
        connection: keyedConnection,
        model: googleModel,
        prompt: "Ping Gemini",
        signal: new AbortController().signal,
      }),
    )
  })
})

describe("sign-in failure messages", () => {
  test("maps local vault, settings, and drain failures without blaming GitHub", () => {
    const drainMessage = signInError(new ProxyProcessError("drain-timeout"))
    expect(drainMessage).toContain("serving an agent request")
    expect(drainMessage).not.toContain("GitHub")

    const vaultMessage = signInError(
      new Error("safeStorage encryption unavailable"),
    )
    expect(vaultMessage).toContain("credentials")
    expect(vaultMessage).not.toContain("GitHub")

    const settingsMessage = signInError(
      Object.assign(new Error("EACCES: permission denied"), {
        path: "/tmp/settings.json",
      }),
    )
    expect(settingsMessage).toContain("settings")
    expect(settingsMessage).not.toContain("GitHub")

    const diskMessage = signInError(
      new Error("ENOSPC: no space left on device"),
    )
    expect(diskMessage).toContain("locally")
    expect(diskMessage).not.toContain("GitHub")

    expect(signInError(new UpstreamError("network"))).toContain("GitHub")
    expect(signInError(new UpstreamError("unauthorized"))).toContain(
      "verify this account",
    )
  })
})

describe("engine crash and protocol hardening", () => {
  test("uncaught engine exception reports an unexpected crashed exit and closes listeners", async () => {
    const upstream = await fixture()
    const port = await availablePort()
    const wrapperPath = join(engineDirectory, "crash-engine.cjs")
    await writeFile(
      wrapperPath,
      [
        "const originalSend = process.send.bind(process)",
        "process.send = (event, ...args) => {",
        '  if (event && event.kind === "ready") {',
        '    setTimeout(() => { throw new Error("simulated engine crash") }, 40)',
        "  }",
        "  return originalSend(event, ...args)",
        "}",
        `require(${JSON.stringify(engineRuntimePath)})`,
      ].join("\n"),
    )
    const exits: Array<{ expected: boolean; reason?: ProxyExitReason }> = []
    const proc = startProxyProcess({
      runtimePath: wrapperPath,
      runtimeExecPath: "node",
      init: {
        kind: "init",
        githubToken: "fixture_github_token",
        gatewayKey,
        port,
        accountType: "individual",
        fixtureOrigin: upstream.origin,
      },
      onActivity: () => undefined,
      onExit: (expected, reason) => exits.push({ expected, reason }),
    })
    cleanups.push(() => proc.stop())
    await proc.ready
    await eventually(() => exits.length === 1)
    expect(exits).toEqual([{ expected: false, reason: "crashed" }])
    await expectRejection(fetch(`http://127.0.0.1:${port}/`))
  }, 15000)

  test("malformed request URL returns HTTP 400 without crashing and logs /v1beta/models", async () => {
    const upstream = await fixture()
    const port = await availablePort()
    const activity: Array<ActivityRecord> = []
    const exits: Array<boolean> = []
    const proc = startProxyProcess({
      runtimePath: engineRuntimePath,
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
      onExit: (expected) => exits.push(expected),
    })
    cleanups.push(() => proc.stop())
    await proc.ready
    const rawResponse = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port }, () => {
        socket.write(
          `GET http://[invalid HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
        )
      })
      let responseText = ""
      socket.setEncoding("utf8")
      socket.on("data", (chunk: string) => {
        responseText += chunk
      })
      socket.once("end", () => resolve(responseText))
      socket.once("error", reject)
    })
    expect(rawResponse).toContain("HTTP/1.1 400")
    expect(rawResponse).toContain("Malformed request URL")
    const healthy = await fetch(`http://127.0.0.1:${port}/v1beta/models`, {
      headers: { "x-goog-api-key": gatewayKey },
    })
    expect(healthy.status).toBe(200)
    await healthy.text()
    await eventually(() => activity.length === 1)
    expect(activity[0]?.path).toBe("/v1beta/models")
    expect(exits).toEqual([])
  }, 15000)

  test("engine rejects control commands before ready and ProxyProcess fails fast on command-rejected", async () => {
    const child = fork(engineRuntimePath, [], {
      execPath: "node",
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json",
    })
    cleanups.push(() => {
      child.kill("SIGKILL")
      return Promise.resolve()
    })
    const rejectedEvent = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out waiting for command-rejected")),
        3000,
      )
      child.once("message", (event) => {
        clearTimeout(timer)
        resolve(event)
      })
      child.once("spawn", () =>
        child.send({ kind: "drain", id: 7, timeoutMs: 10_000 }),
      )
      child.once("error", reject)
    })
    expect(rejectedEvent).toEqual({
      kind: "command-rejected",
      id: 7,
      reason: "not-ready",
    })
    child.kill("SIGKILL")

    const stubPath = join(engineDirectory, "rejecting-engine.cjs")
    await writeFile(
      stubPath,
      [
        'process.on("message", (message) => {',
        '  if (message.kind === "init") process.send({ kind: "ready" })',
        '  else if (message.kind === "drain" || message.kind === "catalog") {',
        '    process.send({ kind: "command-rejected", id: message.id, reason: "stopping" })',
        "  }",
        '  else if (message.kind === "stop") process.send({ kind: "stopped" })',
        '  else if (message.kind === "exit") process.exit(0)',
        "})",
      ].join("\n"),
    )
    const port = await availablePort()
    const proc = startProxyProcess({
      runtimePath: stubPath,
      runtimeExecPath: "node",
      init: {
        kind: "init",
        githubToken: "fixture_github_token",
        gatewayKey,
        port,
        accountType: "individual",
      },
      onActivity: () => undefined,
      onExit: () => undefined,
    })
    cleanups.push(() => proc.stop())
    await proc.ready
    const started = performance.now()
    try {
      await proc.drain(10_000)
      throw new Error("Expected drain rejection")
    } catch (error) {
      expect(error).toBeInstanceOf(ProxyProcessError)
      expect(error instanceof ProxyProcessError ? error.kind : "unknown").toBe(
        "stopped",
      )
    }
    try {
      await proc.updateModels({ object: "list", data: [] })
      throw new Error("Expected catalog rejection")
    } catch (error) {
      expect(error).toBeInstanceOf(ProxyProcessError)
      expect(error instanceof ProxyProcessError ? error.kind : "unknown").toBe(
        "stopped",
      )
    }
    expect(performance.now() - started).toBeLessThan(1500)
  }, 15000)
})

describe("engine exit reason classification", () => {
  test("fatal auth-revoked reports expected=false with reason=auth-revoked", async () => {
    const stubPath = join(engineDirectory, "auth-revoked-engine.cjs")
    await writeFile(
      stubPath,
      [
        'process.on("message", (message) => {',
        '  if (message.kind === "init") {',
        '    process.send({ kind: "ready" })',
        '    setTimeout(() => { process.send({ kind: "fatal", reason: "auth-revoked", code: "authentication" }, () => process.exit(1)) }, 20)',
        "  }",
        "})",
      ].join("\n"),
    )
    const port = await availablePort()
    const exits: Array<{ expected: boolean; reason?: ProxyExitReason }> = []
    const proc = startProxyProcess({
      runtimePath: stubPath,
      runtimeExecPath: "node",
      init: {
        kind: "init",
        githubToken: "fixture_github_token",
        gatewayKey,
        port,
        accountType: "individual",
      },
      onActivity: () => undefined,
      onExit: (expected, reason) => exits.push({ expected, reason }),
    })
    cleanups.push(() => proc.stop())
    await proc.ready
    await eventually(() => exits.length === 1)
    expect(exits).toEqual([{ expected: false, reason: "auth-revoked" }])
  }, 10000)
})
