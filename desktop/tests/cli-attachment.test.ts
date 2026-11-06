import { expect, test } from "bun:test"
import { build } from "esbuild"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
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

import { runtimeOptionsSchema } from "../../src/lib/proxy-contracts"
import { upstreamCatalogSchema } from "../engine/upstream"
import { createController } from "../main/controller"
import { createCredentialVault } from "../main/vault"
import { startFixtureUpstream } from "../testing/upstream"

const root = fileURLToPath(new URL("../../", import.meta.url))
const modelId = "cli-fixture-model"

async function legacyCli(upstreamOrigin: string, requiredKey?: string) {
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
    if (
      requiredKey
      && request.headers.authorization !== `Bearer ${requiredKey}`
    ) {
      response.statusCode = 401
      response.end("Unauthorized")
      return
    }
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

type VaultEncryption = NonNullable<
  Parameters<typeof createCredentialVault>[0]["encryption"]
>

function countedEncryption() {
  const key = randomBytes(32)
  const calls = { encrypt: 0, decrypt: 0 }
  let blocked = false
  const encryption: VaultEncryption = {
    encrypt(value) {
      calls.encrypt++
      if (blocked)
        return Promise.reject(new Error("Native provider is blocked"))
      const nonce = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", key, nonce)
      const ciphertext = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
      ])
      return Promise.resolve(
        Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]),
      )
    },
    decrypt(value) {
      calls.decrypt++
      if (blocked)
        return Promise.reject(new Error("Native provider is blocked"))
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        value.subarray(0, 12),
      )
      decipher.setAuthTag(value.subarray(12, 28))
      const plaintext = Buffer.concat([
        decipher.update(value.subarray(28)),
        decipher.final(),
      ])
      return Promise.resolve({
        result: plaintext.toString("utf8"),
        shouldReEncrypt: false,
      })
    },
  }
  return {
    encryption,
    calls,
    block(value: boolean) {
      blocked = value
      calls.encrypt = 0
      calls.decrypt = 0
    },
  }
}

for (const identification of [
  "anonymous",
  "configured-key",
  "saved-key",
] as const) {
  test(`encrypted startup attaches via ${identification} and preserves native state`, async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "copilot-encrypted-attachment-"),
    )
    const upstream = await startFixtureUpstream()
    const gatewayKey = "fixture_saved_gateway_key_01234567890123456789"
    const runtimeKey = "fixture_custom_runtime_key_01234567890123456789"
    const cli = await legacyCli(
      upstream.origin,
      identification === "anonymous" ? undefined : gatewayKey,
    )
    const provider = countedEncryption()
    const vault = createCredentialVault({
      directory,
      encryption: provider.encryption,
    })
    let controller: DesktopController | undefined
    let cliClosed = false
    try {
      await vault.save({ githubToken: "fixture_github_token", gatewayKey })
      const encryptedAuthentication = await vault.encodeRuntimeAuthentication?.(
        {
          kind: "keyed",
          keys: [runtimeKey],
        },
      )
      if (!encryptedAuthentication)
        throw new Error("Runtime key was not encrypted")
      const settingsPath = join(directory, "settings.json")
      const credentialsPath = join(directory, "credentials.enc")
      const agentPath = join(directory, ".claude", "settings.json")
      await writeFile(
        settingsPath,
        JSON.stringify({
          port: cli.port,
          startOnLaunch: false,
          nativeRuntime: {
            options: runtimeOptionsSchema.parse({
              port: cli.port,
              accountType: "individual",
              manualApprove: false,
              rateLimitSeconds: 0,
              rateLimitWait: false,
              responsesContextTrim: false,
              proxyFromEnvironment: false,
            }),
            authentication: { kind: "keyed" },
            encryptedAuthentication,
          },
        }),
      )
      await mkdir(join(directory, ".claude"))
      await writeFile(
        agentPath,
        JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: cli.origin + "/",
            ANTHROPIC_MODEL: modelId,
            ...(identification === "configured-key" ?
              { ANTHROPIC_AUTH_TOKEN: gatewayKey }
            : {}),
          },
          permissions: { allow: ["Read"] },
        }),
      )
      const protectedPaths = [credentialsPath, settingsPath, agentPath]
      const before = await Promise.all(
        protectedPaths.map((path) => readFile(path)),
      )
      provider.block(identification !== "saved-key")
      const controllerOptions = {
        dataDirectory: directory,
        homeDirectory: directory,
        stateDirectory: join(directory, "native"),
        runtimePath: join(directory, "unused-engine.cjs"),
        runtimeExecPath: "node",
        fixtureOrigin: upstream.origin,
        platform: "darwin",
        version: "0.0.6",
        vault: createCredentialVault({
          directory,
          encryption: provider.encryption,
        }),
        writeClipboard: () => {},
        openExternal: () => Promise.resolve(),
      } satisfies Parameters<typeof createController>[0]
      controller = await createController(controllerOptions)
      expect(controller.sessionApi().snapshot().kind).toBe("legacy")
      expect(controller.snapshot().source.kind).toBe("legacy-cli")
      expect(controller.snapshot().account.kind).toBe("external-unverified")
      expect(controller.snapshot().models.map((model) => model.id)).toEqual([
        modelId,
      ])
      expect(
        (
          await controller.sessionApi().dispatch({
            kind: "ensure-running",
            credential: { kind: "native-saved-account" },
            explicit: {},
          })
        ).kind,
      ).toBe("session-changed")
      await controller.invoke({ kind: "refresh" })
      await controller.dispose()
      expect(provider.calls).toEqual({
        encrypt: 0,
        decrypt: identification === "saved-key" ? 2 : 0,
      })
      expect(
        await Promise.all(protectedPaths.map((path) => readFile(path))),
      ).toEqual(before)
      expect(
        await (
          await fetch(cli.origin, {
            headers:
              identification === "anonymous" ?
                {}
              : { authorization: `Bearer ${gatewayKey}` },
          })
        ).text(),
      ).toBe("Server running")
      if (identification === "saved-key") {
        await cli.close()
        cliClosed = true
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
        provider.block(false)
        controller = await createController({
          ...controllerOptions,
          runtimePath,
        })
        expect(controller.sessionApi().snapshot().kind).toBe("managed")
        expect(provider.calls).toEqual({ encrypt: 0, decrypt: 2 })
        expect(
          await Promise.all(protectedPaths.map((path) => readFile(path))),
        ).toEqual(before)
        await controller.sessionApi().dispatch({
          kind: "ensure-running",
          credential: { kind: "native-saved-account" },
          explicit: {},
        })
        expect(controller.snapshot().account.kind).toBe("signed-in")
        expect(controller.activeConnection()?.authentication).toEqual({
          kind: "keyed",
          key: runtimeKey,
        })
        const response = await fetch(cli.origin + "/models", {
          headers: { authorization: `Bearer ${runtimeKey}` },
        })
        expect(response.status).toBe(200)
        await response.text()
        await controller.dispose()
        expect(await readFile(credentialsPath)).toEqual(before[0])
        expect(await readFile(agentPath)).toEqual(before[2])
      }
    } finally {
      provider.block(false)
      await controller?.dispose()
      if (!cliClosed) await cli.close()
      await upstream.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 10000)
}
