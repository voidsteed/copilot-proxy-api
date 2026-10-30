import { afterEach, expect, test } from "bun:test"
import { build } from "esbuild"
import { rejects } from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

import type { DesktopController } from "../main/types"
import type { DesktopSnapshot } from "../shared/contracts"
import type { FixtureOAuthMode } from "../testing/upstream"

import { snapshotSchema } from "../shared/contracts"
import { startPreviewServer } from "../testing/preview"
import { startFixtureUpstream } from "../testing/upstream"

const cleanups: Array<() => Promise<void>> = []
const fixtureHeaders = {
  authorization: "Bearer fixture_copilot_token",
  "content-type": "application/json",
}
const githubHeaders = { authorization: "token fixture_github_token" }
const eventSchema = z
  .object({
    type: z.string().optional(),
    output_index: z.number().optional(),
    item_id: z.string().optional(),
    delta: z.string().optional(),
    item: z.object({ id: z.string() }).loose().optional(),
    response: z
      .object({
        id: z.string(),
        status: z.string(),
        output: z.array(z.object({ id: z.string() }).loose()),
        usage: z
          .object({
            input_tokens: z.number(),
            output_tokens: z.number(),
            input_tokens_details: z.object({ cached_tokens: z.number() }),
          })
          .nullable(),
      })
      .loose()
      .optional(),
  })
  .loose()

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture() {
  const upstream = await startFixtureUpstream()
  cleanups.push(() => upstream.close())
  return upstream
}

async function deviceCode(origin: string): Promise<string> {
  const result = await fetch(`${origin}/login/device/code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: "local-test-client" }),
  })
  expect(result.status).toBe(200)
  const body = z
    .object({
      device_code: z.string(),
      user_code: z.string(),
      verification_uri: z.string(),
      expires_in: z.number(),
      interval: z.number(),
    })
    .parse(await result.json())
  expect(body.user_code).toMatch(/^BRDG-\d{4}$/)
  expect(body.verification_uri).toBe("https://github.com/login/device")
  expect(body.expires_in).toBe(600)
  expect(body.interval).toBe(1)
  return body.device_code
}

function poll(origin: string, device: string) {
  return fetch(`${origin}/login/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_code: device }),
  }).then((response) => response.json())
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(predicate()).toBe(true)
}

test("device authorization shows a code before yielding synthetic credentials", async () => {
  const upstream = await fixture()
  expect(new URL(upstream.origin).hostname).toBe("127.0.0.1")
  const device = await deviceCode(upstream.origin)
  expect(await poll(upstream.origin, device)).toMatchObject({
    error: "authorization_pending",
  })
  expect(await poll(upstream.origin, device)).toMatchObject({
    error: "authorization_pending",
  })
  const token = z
    .object({ access_token: z.string() })
    .parse(await poll(upstream.origin, device))
  const account = await fetch(`${upstream.origin}/user`, {
    headers: { authorization: `token ${token.access_token}` },
  })
  expect(await account.json()).toMatchObject({
    login: "octocat",
    name: "Mona",
  })
  const copilot = await fetch(`${upstream.origin}/copilot_internal/v2/token`, {
    headers: githubHeaders,
  })
  const session = z
    .object({
      token: z.string(),
      expires_at: z.number(),
      refresh_in: z.number(),
    })
    .parse(await copilot.json())
  expect(session.token).toStartWith("fixture_")
  expect(session.expires_at).toBeGreaterThan(Date.now() / 1000)
  expect(session.refresh_in).toBeGreaterThan(0)
})

test("pending, denial, expiry, and slower polling are explicit OAuth outcomes", async () => {
  const upstream = await fixture()
  const cases: Array<{ mode: FixtureOAuthMode; error: string }> = [
    { mode: "pending", error: "authorization_pending" },
    { mode: "denied", error: "access_denied" },
    { mode: "expired", error: "expired_token" },
    { mode: "slow", error: "slow_down" },
  ]
  for (const outcome of cases) {
    upstream.setOAuthMode(outcome.mode)
    expect(
      await poll(upstream.origin, await deviceCode(upstream.origin)),
    ).toMatchObject({ error: outcome.error })
  }
  expect(await poll(upstream.origin, "not-a-fixture-device")).toMatchObject({
    error: "expired_token",
  })
})

test("authenticated discovery exposes quotas, limits, and endpoint capabilities", async () => {
  const upstream = await fixture()
  const unauthenticated = await fetch(`${upstream.origin}/models`)
  expect(unauthenticated.status).toBe(401)
  const modelsResponse = await fetch(`${upstream.origin}/models`, {
    headers: fixtureHeaders,
  })
  const models = z
    .object({
      data: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          supported_endpoints: z.array(z.string()),
          capabilities: z.object({
            limits: z.object({
              max_context_window_tokens: z.number(),
              max_output_tokens: z.number(),
            }),
            supports: z.object({
              streaming: z.boolean(),
              tool_calls: z.boolean(),
              vision: z.boolean(),
              reasoning_effort: z.array(z.string()).optional(),
            }),
          }),
        }),
      ),
    })
    .parse(await modelsResponse.json()).data
  expect(models.length).toBeGreaterThanOrEqual(5)
  expect(models.every((model) => model.name.includes("local fixture"))).toBe(
    true,
  )
  expect(
    models.some(
      (model) =>
        model.supported_endpoints.length === 1
        && model.supported_endpoints[0] === "/responses",
    ),
  ).toBe(true)
  expect(
    models.some((model) =>
      model.capabilities.supports.reasoning_effort?.includes("high"),
    ),
  ).toBe(true)
  expect(
    models.every(
      (model) =>
        model.capabilities.limits.max_context_window_tokens
        > model.capabilities.limits.max_output_tokens,
    ),
  ).toBe(true)
  const usageResponse = await fetch(
    `${upstream.origin}/copilot_internal/user`,
    { headers: githubHeaders },
  )
  const quotas = z
    .object({
      quota_reset_date: z.string(),
      quota_snapshots: z.object({
        chat: z.object({ unlimited: z.boolean() }),
        premium_interactions: z.object({
          entitlement: z.number(),
          remaining: z.number(),
          unlimited: z.boolean(),
        }),
      }),
    })
    .parse(await usageResponse.json())
  expect(quotas.quota_snapshots.chat.unlimited).toBe(true)
  expect(quotas.quota_snapshots.premium_interactions).toMatchObject({
    remaining: 246,
    entitlement: 300,
    unlimited: false,
  })
  expect(Number.isFinite(Date.parse(quotas.quota_reset_date))).toBe(true)
})

test("buffered chat and Responses include useful replies and observable token usage", async () => {
  const upstream = await fixture()
  const chat = await fetch(`${upstream.origin}/chat/completions`, {
    method: "POST",
    headers: fixtureHeaders,
    body: JSON.stringify({
      model: "fixture-gpt-4.1",
      messages: [{ role: "user", content: "What is 2 + 3?" }],
    }),
  })
  expect(chat.status).toBe(200)
  expect(await chat.json()).toMatchObject({
    choices: [
      {
        message: { role: "assistant", content: "2 + 3 = 5." },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 37,
      completion_tokens: 9,
      prompt_tokens_details: { cached_tokens: 5 },
    },
  })
  const responses = await fetch(`${upstream.origin}/responses`, {
    method: "POST",
    headers: fixtureHeaders,
    body: JSON.stringify({
      model: "fixture-responses-only",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Check the connection" }],
        },
      ],
    }),
  })
  expect(responses.status).toBe(200)
  expect(await responses.json()).toMatchObject({
    status: "completed",
    output_text: "Copilot Bridge is connected.",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "Copilot Bridge is connected." },
        ],
      },
    ],
    usage: {
      input_tokens: 37,
      output_tokens: 9,
      input_tokens_details: { cached_tokens: 5 },
    },
  })
})

test("chat SSE finishes with usage and a DONE marker", async () => {
  const upstream = await fixture()
  const response = await fetch(`${upstream.origin}/chat/completions`, {
    method: "POST",
    headers: fixtureHeaders,
    body: JSON.stringify({
      model: "fixture-gpt-4.1",
      stream: true,
      messages: [{ role: "user", content: "Check the connection" }],
    }),
  })
  expect(response.headers.get("content-type")).toContain("text/event-stream")
  const stream = await response.text()
  const payloads = stream.split("\n\n").flatMap((block) => {
    if (!block.startsWith("data: ") || block.includes("[DONE]")) return []
    const value: unknown = JSON.parse(block.slice(6))
    return [value]
  })
  const chunks = z
    .array(
      z.object({
        id: z.string(),
        choices: z.array(
          z.object({
            delta: z.object({ content: z.string().optional() }),
            finish_reason: z.string().nullable(),
          }),
        ),
        usage: z
          .object({
            prompt_tokens: z.number(),
            completion_tokens: z.number(),
            prompt_tokens_details: z.object({ cached_tokens: z.number() }),
          })
          .optional(),
      }),
    )
    .parse(payloads)
  expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(1)
  expect(
    chunks
      .flatMap((chunk) =>
        chunk.choices.map((choice) => choice.delta.content ?? ""),
      )
      .join(""),
  ).toBe("Copilot Bridge is connected.")
  expect(
    chunks.some((chunk) =>
      chunk.choices.some((choice) => choice.finish_reason === "stop"),
    ),
  ).toBe(true)
  expect(chunks.find((chunk) => chunk.usage)?.usage).toMatchObject({
    prompt_tokens: 37,
    completion_tokens: 9,
    prompt_tokens_details: { cached_tokens: 5 },
  })
  expect(stream.trimEnd()).toEndWith("data: [DONE]")
  expect(upstream.metrics.completedStreams).toBe(1)
})

test("Responses SSE keeps every output item ID consistent through completion", async () => {
  const upstream = await fixture()
  const response = await fetch(`${upstream.origin}/responses`, {
    method: "POST",
    headers: fixtureHeaders,
    body: JSON.stringify({
      model: "fixture-responses-only",
      input: "Check the connection",
      stream: true,
    }),
  })
  const frames = (await response.text())
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const data = block.split("\n").find((line) => line.startsWith("data: "))
      expect(data).toBeDefined()
      return eventSchema.parse(JSON.parse(data?.slice(6) ?? "null"))
    })
  expect(frames.map((frame) => frame.type)).toEqual([
    "response.created",
    "response.in_progress",
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.output_text.delta",
    "response.output_text.delta",
    "response.output_text.delta",
    "response.output_text.done",
    "response.content_part.done",
    "response.output_item.done",
    "response.completed",
  ])
  const item = frames.find(
    (frame) => frame.type === "response.output_item.added",
  )?.item
  expect(item).toBeDefined()
  expect(
    frames
      .filter((frame) => frame.item_id)
      .every((frame) => frame.item_id === item?.id),
  ).toBe(true)
  expect(
    frames.find((frame) => frame.type === "response.output_item.done")?.item
      ?.id,
  ).toBe(item?.id)
  const completed = frames.find(
    (frame) => frame.type === "response.completed",
  )?.response
  expect(completed?.output[0]?.id).toBe(item?.id)
  expect(completed?.status).toBe("completed")
  expect(completed?.usage).toMatchObject({
    input_tokens: 37,
    output_tokens: 9,
    input_tokens_details: { cached_tokens: 5 },
  })
  expect(frames.map((frame) => frame.delta ?? "").join("")).toBe(
    "Copilot Bridge is connected.",
  )
})

test("failure markers produce actionable HTTP errors", async () => {
  const upstream = await fixture()
  const failed = await fetch(`${upstream.origin}/responses`, {
    method: "POST",
    headers: fixtureHeaders,
    body: JSON.stringify({
      model: "fixture-responses-only",
      input: "fixture:fail",
    }),
  })
  expect(failed.status).toBe(503)
  expect(await failed.json()).toMatchObject({
    error: { code: "fixture_failure" },
  })
})

test("invalid bodies and unsupported endpoints fail without a successful generation", async () => {
  const upstream = await fixture()
  for (const body of [
    "{broken",
    JSON.stringify({ model: "fixture-gpt-4.1", messages: "invalid" }),
    JSON.stringify({
      model: "fixture-responses-only",
      messages: [{ role: "user", content: "hello" }],
    }),
  ]) {
    const response = await fetch(`${upstream.origin}/chat/completions`, {
      method: "POST",
      headers: fixtureHeaders,
      body,
    })
    expect(response.status).toBe(400)
    await response.text()
  }
  await upstream.close()
  await rejects(fetch(`${upstream.origin}/models`, { headers: fixtureHeaders }))
})

function previewController() {
  let state = snapshotSchema.parse({
    revision: 0,
    version: "0.0.1",
    platform: "darwin",
    fixture: true,
    storageMode: "session-only",
    account: { kind: "signed-out" },
    gateway: { kind: "stopped" },
    settings: {},
    models: [],
    modelsFetchedAt: null,
    usage: null,
    activity: [],
    totals: {
      requests: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
    },
    probe: { kind: "idle" },
    notice: null,
  })
  const listeners = new Set<(snapshot: DesktopSnapshot) => void>()
  const commands: Array<unknown> = []
  const controller: DesktopController = {
    snapshot: () => state,
    invoke: (input) => {
      commands.push(input)
      state = { ...state, revision: state.revision + 1 }
      for (const listener of listeners) listener(state)
      return Promise.resolve(state)
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose: () => Promise.resolve(),
  }
  return { controller, commands, listeners }
}

async function preview() {
  const directory = await mkdtemp(
    join(tmpdir(), "copilot-bridge-fixtures-tests-"),
  )
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const renderer = join(directory, "renderer")
  await mkdir(renderer)
  await writeFile(
    join(renderer, "index.html"),
    "<!doctype html><title>Fixture preview</title>",
  )
  await writeFile(
    join(renderer, "app.js"),
    "document.title = 'Fixture preview'",
  )
  await writeFile(join(directory, "outside.txt"), "outside renderer")
  await symlink(join(directory, "outside.txt"), join(renderer, "escape.txt"))
  const state = previewController()
  const server = await startPreviewServer({
    controller: state.controller,
    rendererDirectory: renderer,
  })
  cleanups.push(() => server.close())
  return { ...state, ...server, renderer }
}

function rawRequest(
  origin: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(origin, { path, headers }, (response) => {
      const chunks: Array<Buffer> = []
      response.on("data", (chunk: Buffer) => {
        chunks.push(chunk)
      })
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      )
    })
    request.once("error", reject)
    request.end()
  })
}

test("serves renderer files and SPA routes with safe MIME types", async () => {
  const server = await preview()
  const page = await fetch(server.origin)
  expect(page.status).toBe(200)
  expect(page.headers.get("content-type")).toContain("text/html")
  expect(await page.text()).toContain("Fixture preview")
  const script = await fetch(`${server.origin}/app.js`)
  expect(script.headers.get("content-type")).toContain("text/javascript")
  expect(await script.text()).toContain("document.title")
  const route = await fetch(`${server.origin}/models`)
  expect(await route.text()).toContain("Fixture preview")
  expect((await fetch(`${server.origin}/missing.js`)).status).toBe(404)
  expect((await fetch(server.origin, { method: "HEAD" })).status).toBe(200)
})

test("commands are bounded, validated, same-origin, and return safe snapshots", async () => {
  const server = await preview()
  const snapshot = await fetch(`${server.origin}/__desktop/snapshot`)
  expect(snapshotSchema.parse(await snapshot.json()).fixture).toBe(true)
  const command = (
    body: string,
    origin = server.origin,
    contentType = "application/json",
  ) =>
    fetch(`${server.origin}/__desktop/command`, {
      method: "POST",
      headers: { origin, "content-type": contentType },
      body,
    })
  const response = await command(JSON.stringify({ kind: "clear-activity" }))
  expect(response.status).toBe(200)
  expect(snapshotSchema.parse(await response.json()).revision).toBe(1)
  expect(server.commands).toEqual([{ kind: "clear-activity" }])
  expect(
    (
      await command(
        JSON.stringify({
          kind: "clear-activity",
          githubToken: "not-allowed",
        }),
      )
    ).status,
  ).toBe(400)
  expect((await command("{invalid")).status).toBe(400)
  expect((await command("x".repeat(70000))).status).toBe(400)
  expect((await command("{}", "https://example.test")).status).toBe(403)
  expect((await command("{}", server.origin, "text/plain")).status).toBe(415)
  expect(
    (
      await fetch(`${server.origin}/__desktop/command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).status,
  ).toBe(403)
  expect(server.commands).toHaveLength(1)
})

test("SSE publishes initial and changed snapshots and removes listeners on close", async () => {
  const server = await preview()
  const abort = new AbortController()
  const response = await fetch(`${server.origin}/__desktop/events`, {
    signal: abort.signal,
  })
  const reader = response.body?.getReader()
  expect(reader).toBeDefined()
  expect(new TextDecoder().decode((await reader?.read())?.value)).toContain(
    "event: snapshot",
  )
  expect(server.listeners.size).toBe(1)
  await server.controller.invoke({ kind: "clear-activity" })
  expect(new TextDecoder().decode((await reader?.read())?.value)).toContain(
    '"revision":1',
  )
  await server.close()
  await eventually(() => server.listeners.size === 0)
})

test("snapshot responses strip fields outside the renderer contract", async () => {
  const server = await preview()
  const sentinel = "upstream-credential-must-stay-native"
  const controller: DesktopController = {
    ...server.controller,
    snapshot: () => ({
      ...server.controller.snapshot(),
      githubToken: sentinel,
      account: { ...server.controller.snapshot().account, token: sentinel },
    }),
  }
  const isolated = await startPreviewServer({
    controller,
    rendererDirectory: server.renderer,
  })
  cleanups.push(() => isolated.close())
  const response = await fetch(`${isolated.origin}/__desktop/snapshot`)
  const body = await response.text()
  expect(response.status).toBe(200)
  expect(body).not.toContain(sentinel)
  expect(body).not.toContain("githubToken")
  expect(response.headers.get("access-control-allow-origin")).toBeNull()
})

test("rejects unexpected origins, hostnames, and symlink escapes", async () => {
  const server = await preview()
  expect(
    (
      await rawRequest(server.origin, "/__desktop/snapshot", {
        host: "evil.test",
      })
    ).status,
  ).toBe(403)
  expect(
    (
      await fetch(`${server.origin}/__desktop/snapshot`, {
        headers: { origin: "null" },
      })
    ).status,
  ).toBe(403)
  expect(
    (
      await fetch(`${server.origin}/__desktop/snapshot`, {
        headers: { "sec-fetch-site": "cross-site" },
      })
    ).status,
  ).toBe(403)
  expect((await fetch(`${server.origin}/escape.txt`)).status).toBe(403)
  expect((await fetch(`${server.origin}/__desktop/credentials`)).status).toBe(
    404,
  )
})

test("rejects live controllers and closes all SSE clients with the server", async () => {
  const server = await preview()
  const live: DesktopController = {
    ...server.controller,
    snapshot: () => ({ ...server.controller.snapshot(), fixture: false }),
  }
  await rejects(
    startPreviewServer({
      controller: live,
      rendererDirectory: server.renderer,
    }),
    /fixture/,
  )
  const response = await fetch(`${server.origin}/__desktop/events`)
  const reader = response.body?.getReader()
  await reader?.read()
  await server.close()
  await eventually(() => server.listeners.size === 0)
  await rejects(fetch(server.origin))
})

test("Node transport preserves cancellation, SSE disconnects, and raw path validation", async () => {
  const server = await preview()
  const compiled = await build({
    stdin: {
      contents: `
          import assert from "node:assert/strict"
          import { request } from "node:http"
          import { startFixtureUpstream } from ${JSON.stringify(fileURLToPath(new URL("../testing/upstream.ts", import.meta.url)))}
          import { startPreviewServer } from ${JSON.stringify(fileURLToPath(new URL("../testing/preview.ts", import.meta.url)))}
          const state = ${JSON.stringify(server.controller.snapshot())}
          const listeners = new Set()
          const controller = {
            snapshot: () => state,
            invoke: async () => state,
            subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
            dispose: async () => {},
          }
          const upstream = await startFixtureUpstream()
          const preview = await startPreviewServer({ controller, rendererDirectory: ${JSON.stringify(server.renderer)} })
          async function eventually(predicate) {
            for (let attempt = 0; attempt < 100; attempt++) {
              if (predicate()) return
              await new Promise(resolve => setTimeout(resolve, 10))
            }
            assert.ok(predicate(), "Node server observed disconnected client")
          }
          async function rawStatus(path) {
            return await new Promise((resolve, reject) => {
              const req = request(preview.origin, { path }, response => {
                response.resume()
                response.once("end", () => resolve(response.statusCode))
              })
              req.once("error", reject)
              req.end()
            })
          }
          try {
            assert.equal(await rawStatus("/%2e%2e/outside.txt"), 403)
            assert.equal(await rawStatus("/%5c..%5coutside.txt"), 403)
            const command = await fetch(preview.origin + "/__desktop/command", {
              method: "POST", headers: { origin: preview.origin, "content-type": "application/json" },
              body: "x".repeat(70000),
            })
            assert.equal(command.status, 400)
            await command.text()
            const abort = new AbortController()
            const response = await fetch(upstream.origin + "/responses", {
              method: "POST", headers: { authorization: "Bearer fixture_copilot_token", "content-type": "application/json" },
              body: JSON.stringify({ model: "fixture-responses-only", input: "fixture:long", stream: true }),
              signal: abort.signal,
            })
            const reader = response.body.getReader()
            assert.equal((await reader.read()).done, false)
            abort.abort()
            await reader.cancel().catch(() => {})
            await eventually(() => upstream.metrics.abortedStreams === 1)
            assert.equal(upstream.metrics.completedStreams, 0)
            const eventAbort = new AbortController()
            const events = await fetch(preview.origin + "/__desktop/events", { signal: eventAbort.signal })
            const eventReader = events.body.getReader()
            assert.equal((await eventReader.read()).done, false)
            assert.equal(listeners.size, 1)
            eventAbort.abort()
            await eventReader.cancel().catch(() => {})
            await eventually(() => listeners.size === 0)
          } finally {
            await preview.close()
            await upstream.close()
          }
        `,
      loader: "js",
      resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    },
    platform: "node",
    format: "esm",
    bundle: true,
    write: false,
    logLevel: "silent",
  })
  const code = compiled.outputFiles[0]?.text
  expect(code).toBeDefined()
  const child = spawn("node", ["--input-type=module"], {
    stdio: ["pipe", "pipe", "pipe"],
  })
  cleanups.push(() => {
    child.kill()
    return Promise.resolve()
  })
  let diagnostics = ""
  child.stderr.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString("utf8")
  })
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", resolve)
  })
  child.stdin.end(code)
  expect(await exit, diagnostics).toBe(0)
}, 15000)
