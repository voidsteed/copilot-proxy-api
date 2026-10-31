import { expect, test } from "bun:test"
import { build } from "esbuild"
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

import type { RequestTrace } from "../../src/lib/request-trace"
import type { CredentialVault, DesktopController } from "../main/types"

import { upstreamCatalogSchema } from "../engine/upstream"
import { createController } from "../main/controller"
import { startFixtureUpstream } from "../testing/upstream"

const root = fileURLToPath(new URL("../../", import.meta.url))
const modelId = "cli-fixture-model"

async function legacyCli(upstreamOrigin: string) {
  const modelsResponse = await fetch(`${upstreamOrigin}/models`, {
    headers: { authorization: "Bearer fixture_copilot_token" },
  })
  expect(modelsResponse.status).toBe(200)
  const catalog = upstreamCatalogSchema.parse(await modelsResponse.json())
  const model = catalog.data.find((item) => item.capabilities.type === "chat")
  if (!model) throw new Error("The upstream fixture has no chat model.")
  const usageResponse = await fetch(`${upstreamOrigin}/copilot_internal/user`, {
    headers: { authorization: "token fixture_github_token" },
  })
  expect(usageResponse.status).toBe(200)
  const replies = new Map([
    [
      "/models",
      JSON.stringify({ ...catalog, data: [{ ...model, id: modelId }] }),
    ],
    ["/usage", await usageResponse.text()],
  ])
  const history: Array<RequestTrace> = []
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname
    request.resume()
    if (request.method === "GET" && path === "/") {
      response.end("Server running")
      return
    }
    response.setHeader("content-type", "application/json")
    if (request.method === "POST" && path === "/v1/responses") {
      const startedAtMs = Date.now()
      response.once("finish", () => {
        history.unshift({
          id: "cli-terminal-request",
          method: "POST",
          path,
          status: 200,
          ok: true,
          startedAt: new Date(startedAtMs).toISOString(),
          durationMs: Date.now() - startedAtMs,
        })
      })
      response.end(
        JSON.stringify({ object: "response", output_text: "CLI connected" }),
      )
      return
    }
    const body =
      path === "/debug/requests" ?
        JSON.stringify({ object: "list", data: history })
      : replies.get(path.replace(/^\/v1(?=\/models$)/, ""))
    response.statusCode = body === undefined ? 404 : 200
    response.end(body ?? JSON.stringify({ error: "Unknown fixture route" }))
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

async function settledGateway(controller: DesktopController) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const snapshot = controller.snapshot()
    if (
      snapshot.gateway.kind === "running"
      || snapshot.gateway.kind === "error"
    )
      return snapshot
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("The desktop gateway did not settle within three seconds.")
}

test("desktop attaches to an existing CLI and preserves it on disposal", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "copilot-proxy-cli-attachment-"),
  )
  const upstream = await startFixtureUpstream()
  const cli = await legacyCli(upstream.origin)
  let controller: DesktopController | undefined
  try {
    const runtimePath = join(directory, "engine.cjs")
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
      target: "node24",
      external: ["pdf-parse"],
      logLevel: "silent",
    })
    await writeFile(
      join(directory, "settings.json"),
      JSON.stringify({ port: cli.port, startOnLaunch: true }),
    )
    await mkdir(join(directory, ".claude"))
    await writeFile(
      join(directory, ".claude", "settings.json"),
      JSON.stringify({
        env: { ANTHROPIC_BASE_URL: `${cli.origin}/`, ANTHROPIC_MODEL: modelId },
      }),
    )
    const cliRequest = await fetch(`${cli.origin}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: modelId,
        input: "Terminal connection check",
      }),
    })
    expect(cliRequest.status).toBe(200)
    await cliRequest.text()
    const vault: CredentialVault = {
      mode: "session-only",
      load: () =>
        Promise.resolve({
          githubToken: "fixture_github_token",
          gatewayKey: "fixture_gateway_key_012345678901234567890123456789",
        }),
      save: () => Promise.resolve(),
      clear: () => Promise.resolve(),
    }
    const clipboard: Array<string> = []
    controller = await createController({
      dataDirectory: directory,
      runtimePath,
      runtimeExecPath: "node",
      fixtureOrigin: upstream.origin,
      platform: "darwin",
      version: "0.0.2",
      vault,
      writeClipboard: (text) => {
        clipboard.push(text)
      },
      openExternal: () => Promise.resolve(),
    })
    const snapshot = await settledGateway(controller)
    expect(snapshot.gateway).toMatchObject({
      kind: "running",
      url: `${cli.origin}/v1`,
    })
    expect(snapshot.models.map((item) => item.id)).toEqual([modelId])
    expect(
      snapshot.activity.find((item) => item.path === "/v1/responses")?.status,
    ).toBe(200)
    await controller.invoke({ kind: "copy", target: "base-url" })
    expect(clipboard.at(-1)).toBe(`${cli.origin}/v1`)
    await controller.dispose()
    expect(await (await fetch(cli.origin)).text()).toBe("Server running")
    expect(
      await readFile(join(directory, ".claude", "settings.json"), "utf8"),
    ).toContain(`${cli.origin}/`)
  } finally {
    await controller?.dispose()
    await cli.close()
    await upstream.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 10000)
