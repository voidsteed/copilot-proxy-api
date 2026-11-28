import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test"
import { build } from "esbuild"
import { rejects } from "node:assert/strict"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import { fileURLToPath } from "node:url"

import type { BridgeOutgoingMessage, HostCall } from "../index"
import type { DesktopSnapshot } from "../shared/contracts"

import {
  cliProxyOptions,
  observeProxySession,
  proxyStateDirectory,
} from "../../../src/lib/proxy-session"
import {
  bridgeOutgoingMessageSchema,
  createBridgeHostAdapters,
  createBridgeProtocol,
  createHostVaultEncryption,
  defaultDataDirectory,
  isBridgeEntrypoint,
  parseBridgeArgs,
} from "../index"
import { createCredentialVault } from "../main/vault"

const root = fileURLToPath(new URL("../../../", import.meta.url))
let bundleDirectory = ""
let bridgeBundlePath = ""
let engineBundlePath = ""
const cleanupTasks: Array<() => Promise<void>> = []

beforeAll(async () => {
  bundleDirectory = await mkdtemp(
    path.join(tmpdir(), "copilot-proxy-bridge-tests-"),
  )
  bridgeBundlePath = path.join(bundleDirectory, "bridge.cjs")
  engineBundlePath = path.join(bundleDirectory, "engine.cjs")
  await symlink(
    await realpath(path.join(root, "desktop-rust/bridge/node_modules")),
    path.join(bundleDirectory, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  )
  await build({
    absWorkingDir: path.join(root, "desktop-rust/bridge"),
    entryPoints: {
      bridge: "index.ts",
      engine: "engine/index.ts",
    },
    outdir: bundleDirectory,
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    alias: { "~": path.resolve(root, "src") },
    external: ["pdf-parse", "jsonc-parser"],
    logLevel: "silent",
  })
}, 30_000)

afterEach(async () => {
  for (const task of cleanupTasks.splice(0).reverse()) await task()
})

afterAll(async () => {
  if (bundleDirectory)
    await rm(bundleDirectory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    })
})

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  cleanupTasks.push(() =>
    rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  )
  return dir
}

function createAesCipher() {
  const key = randomBytes(32)
  return {
    encrypt(plaintext: string): string {
      const nonce = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", key, nonce)
      const ciphertext = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ])
      return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString(
        "base64",
      )
    },
    decrypt(ciphertextBase64: string): string {
      const bytes = Buffer.from(ciphertextBase64, "base64")
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        bytes.subarray(0, 12),
      )
      decipher.setAuthTag(bytes.subarray(12, 28))
      return Buffer.concat([
        decipher.update(bytes.subarray(28)),
        decipher.final(),
      ]).toString("utf8")
    },
  }
}

interface HostCallResponse {
  ok: boolean
  value?: unknown
  error?: string | null
}

interface BridgeClient {
  readonly child: ChildProcessWithoutNullStreams
  readonly messages: Array<BridgeOutgoingMessage>
  readonly hostCalls: Array<HostCall>
  readonly stderrChunks: Array<string>
  readonly exited: Promise<{
    code: number | null
    signal: NodeJS.Signals | null
  }>
  send(message: unknown): void
  waitForMessage<T extends BridgeOutgoingMessage>(
    predicate: (message: BridgeOutgoingMessage) => message is T,
    timeoutMs?: number,
  ): Promise<T>
  sendCommand(
    command: unknown,
    timeoutMs?: number,
  ): Promise<Extract<BridgeOutgoingMessage, { type: "response" }>["response"]>
  closeStdin(): void
}

function spawnBridge(
  args: ReadonlyArray<string>,
  onHostCall: (
    call: HostCall,
  ) => HostCallResponse | Promise<HostCallResponse> = () => ({ ok: true }),
): BridgeClient {
  const child = spawn("node", [bridgeBundlePath, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
  })
  const messages: Array<BridgeOutgoingMessage> = []
  const hostCalls: Array<HostCall> = []
  const stderrChunks: Array<string> = []
  const waiters = new Set<() => void>()
  let commandId = 0
  let stdoutBuffer = ""

  const exited = new Promise<{
    code: number | null
    signal: NodeJS.Signals | null
  }>((resolve) => {
    let settled = false
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      resolve({ code, signal })
    }
    child.once("exit", finish)
    child.once("close", finish)
    child.once("error", () => finish(1, null))
  })

  cleanupTasks.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.stdin.destroy()
    child.stdout.destroy()
    child.stderr.destroy()
    child.kill()
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ])
  })

  function send(message: unknown): void {
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  function handleMessage(message: BridgeOutgoingMessage): void {
    messages.push(message)
    if (message.type === "host-call") {
      hostCalls.push(message.call)
      void Promise.resolve(onHostCall(message.call)).then((result) => {
        if (!child.stdin.writableEnded && !child.stdin.destroyed) {
          send({
            type: "host-result",
            id: message.id,
            ok: result.ok,
            value: result.value,
            error: result.error,
          })
        }
      })
    }
    for (const notify of waiters) notify()
  }

  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk
    let newlineIndex = stdoutBuffer.indexOf("\n")
    while (newlineIndex !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex)
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
      if (line.trim().length > 0) {
        const parsed = bridgeOutgoingMessageSchema.parse(JSON.parse(line))
        handleMessage(parsed)
      }
      newlineIndex = stdoutBuffer.indexOf("\n")
    }
  })

  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    stderrChunks.push(chunk)
  })

  function waitForMessage<T extends BridgeOutgoingMessage>(
    predicate: (message: BridgeOutgoingMessage) => message is T,
    timeoutMs = 15_000,
  ): Promise<T> {
    const existing = messages.find((entry): entry is T => predicate(entry))
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const onUpdate = () => {
        const match = messages.find((entry): entry is T => predicate(entry))
        if (!match) return
        clearTimeout(timer)
        waiters.delete(onUpdate)
        resolve(match)
      }
      const timer = setTimeout(() => {
        waiters.delete(onUpdate)
        reject(
          new Error(
            `Timed out waiting for bridge message. stderr: ${stderrChunks.join("")}`,
          ),
        )
      }, timeoutMs)
      waiters.add(onUpdate)
    })
  }

  async function sendCommand(command: unknown, timeoutMs = 15_000) {
    const id = ++commandId
    send({ type: "command", id, command })
    const reply = await waitForMessage(
      (
        message,
      ): message is Extract<BridgeOutgoingMessage, { type: "response" }> =>
        message.type === "response" && message.id === id,
      timeoutMs,
    )
    return reply.response
  }

  return {
    child,
    messages,
    hostCalls,
    stderrChunks,
    exited,
    send,
    waitForMessage,
    sendCommand,
    closeStdin: () => {
      child.stdin.end()
      if (process.platform === "win32") child.stdin.destroy()
    },
  }
}

async function waitForExit(
  client: BridgeClient,
  timeoutMs = 15_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      client.exited,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `Timed out waiting for bridge exit. stderr: ${client.stderrChunks.join("")}`,
            ),
          )
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

describe("CLI flag parsing and vault isolation", () => {
  test("parses platform defaults and explicit flags", () => {
    expect(defaultDataDirectory("darwin", "/Users/alice", {})).toBe(
      path.join(
        "/Users/alice",
        "Library",
        "Application Support",
        "Copilot Proxy",
      ),
    )
    expect(
      defaultDataDirectory("win32", String.raw`C:\Users\alice`, {
        APPDATA: String.raw`C:\Users\alice\AppData\Roaming`,
      }),
    ).toBe(
      path.join(String.raw`C:\Users\alice\AppData\Roaming`, "Copilot Proxy"),
    )
    expect(defaultDataDirectory("linux", "/home/alice", {})).toBe(
      path.join("/home/alice", ".config", "Copilot Proxy"),
    )

    const defaults = parseBridgeArgs([], {
      platform: "darwin",
      homeDirectory: "/Users/alice",
      env: {},
      scriptPath: "/app/dist/bridge.cjs",
      defaultVersion: "0.0.8",
    })
    expect(defaults).toEqual({
      dataDirectory: path.join(
        "/Users/alice",
        "Library",
        "Application Support",
        "Copilot Proxy",
      ),
      stateDirectory: proxyStateDirectory("/Users/alice"),
      enginePath: path.join(path.resolve("/app/dist"), "engine.cjs"),
      version: "0.0.8",
      fixture: false,
      encryption: "session-only",
      platform: "darwin",
    })

    const explicit = parseBridgeArgs(
      [
        "--data-dir",
        "/tmp/custom-data",
        "--engine-path=/tmp/custom/engine.cjs",
        "--version",
        "1.2.3",
        "--fixture",
        "--encryption",
        "encrypted",
      ],
      {
        platform: "linux",
        homeDirectory: "/home/alice",
        env: {},
        scriptPath: "/app/dist/bridge.cjs",
      },
    )
    expect(explicit).toEqual({
      dataDirectory: path.resolve("/tmp/custom-data"),
      stateDirectory: path.join(path.resolve("/tmp/custom-data"), "native"),
      enginePath: path.resolve("/tmp/custom/engine.cjs"),
      version: "1.2.3",
      fixture: true,
      encryption: "encrypted",
      platform: "linux",
    })
  })

  test("rejects invalid flags and detects CLI entrypoint accurately", () => {
    expect(() =>
      parseBridgeArgs(["--encryption", "plaintext"], {
        platform: "darwin",
        homeDirectory: "/Users/alice",
        env: {},
      }),
    ).toThrow()
    expect(() =>
      parseBridgeArgs(["--unknown-flag"], {
        platform: "darwin",
        homeDirectory: "/Users/alice",
        env: {},
      }),
    ).toThrow(/Unknown bridge flag/)
    expect(() =>
      parseBridgeArgs(["--data-dir"], {
        platform: "darwin",
        homeDirectory: "/Users/alice",
        env: {},
      }),
    ).toThrow(/Missing value/)

    expect(isBridgeEntrypoint("/app/dist/bridge.cjs")).toBe(true)
    expect(isBridgeEntrypoint("/repo/desktop-rust/bridge/index.ts")).toBe(true)
    expect(isBridgeEntrypoint("test")).toBe(false)
    expect(
      isBridgeEntrypoint(
        "/repo/desktop-rust/bridge/tests/bridge-protocol.test.ts",
      ),
    ).toBe(false)
  })

  test("custom vault filename isolates Rust credentials from Electron credentials", async () => {
    const directory = await createTempDir("copilot-proxy-vault-isolation-")
    const cipher = createAesCipher()
    const encryption = createHostVaultEncryption((call) => {
      if (call.kind === "vault-encrypt")
        return Promise.resolve(cipher.encrypt(call.plaintext))
      if (call.kind === "vault-decrypt")
        return Promise.resolve(cipher.decrypt(call.ciphertext))
      throw new Error(`Unexpected call: ${call.kind}`)
    })
    const electronVault = createCredentialVault({ directory, encryption })
    const rustVault = createCredentialVault({
      directory,
      encryption,
      filename: "credentials-rust.enc",
    })
    const electronCreds = {
      githubToken: "electron_token",
      gatewayKey: "electron_gateway_key_01234567890123456789",
    }
    const rustCreds = {
      githubToken: "rust_token",
      gatewayKey: "rust_gateway_key_012345678901234567890123",
    }
    await electronVault.save(electronCreds)
    await rustVault.save(rustCreds)
    expect((await readdir(directory)).sort()).toEqual([
      "credentials-rust.enc",
      "credentials.enc",
    ])
    expect(await electronVault.load()).toEqual(electronCreds)
    expect(await rustVault.load()).toEqual(rustCreds)

    await rustVault.clear()
    expect(await rustVault.load()).toBeNull()
    expect(await electronVault.load()).toEqual(electronCreds)
    expect(() =>
      createCredentialVault({
        directory,
        encryption: null,
        filename: "../escape.enc",
      }),
    ).toThrow(/single file name/)
  })
})

describe("NDJSON protocol handler", () => {
  test("handles host-call round-trip, serde nulls, timeouts, malformed stdin, and open-external guard", async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const stderr = new PassThrough()
    const outgoing: Array<BridgeOutgoingMessage> = []
    let stderrText = ""
    let shutdownCount = 0

    output.setEncoding("utf8")
    output.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim().length > 0)
          outgoing.push(bridgeOutgoingMessageSchema.parse(JSON.parse(line)))
      }
    })
    stderr.setEncoding("utf8")
    stderr.on("data", (chunk: string) => {
      stderrText += chunk
    })

    const protocol = createBridgeProtocol({
      input,
      output,
      stderr,
      hostCallTimeoutMs: 60,
      onShutdown: () => {
        shutdownCount++
      },
    })

    const adapters = createBridgeHostAdapters((call) => protocol.callHost(call))
    await rejects(adapters.openExternal("https://evil.example/phish"), {
      message: "Only GitHub sign-in can be opened.",
    })
    expect(outgoing).toHaveLength(0)

    const clipPromise = protocol.callHost({
      kind: "write-clipboard",
      text: "hello 🌍",
    })
    const firstCall = outgoing.at(-1)
    expect(firstCall?.type).toBe("host-call")
    if (firstCall?.type !== "host-call") throw new Error("Expected host-call")

    input.write("not valid json\n")
    input.write('{"type":"unknown"}\n')
    const resultPayload = JSON.stringify({
      type: "host-result",
      id: firstCall.id,
      ok: true,
      value: null,
      error: null,
    })
    const splitPoint = Math.floor(resultPayload.length / 2)
    input.write(resultPayload.slice(0, splitPoint))
    input.write(`${resultPayload.slice(splitPoint)}\n`)
    await clipPromise
    expect(stderrText).toContain("malformed JSON")
    expect(stderrText).toContain("invalid protocol message")

    const failingCall = protocol.callHost({ kind: "show-ui" })
    const secondCall = outgoing.at(-1)
    if (secondCall?.type !== "host-call") throw new Error("Expected host-call")
    input.write(
      `${JSON.stringify({ type: "host-result", id: secondCall.id, ok: false, error: "Window unavailable" })}\n`,
    )
    await rejects(failingCall, { message: "Window unavailable" })

    await rejects(protocol.callHost({ kind: "show-ui" }), /timed out/)

    const interrupted = protocol.callHost({ kind: "show-ui" })
    protocol.beginShutdown()
    await rejects(interrupted, /shutting down/)

    input.write('{"type":"shutdown"}\n')
    expect(shutdownCount).toBe(1)
    protocol.close()
  })
})

describe("built bridge.cjs subprocess E2E under Node 24", () => {
  test("bundle contains no Electron or original-fs imports", async () => {
    const source = await readFile(bridgeBundlePath, "utf8")
    expect(source).not.toContain('require("electron")')
    expect(source).not.toContain('require("original-fs")')
  })

  test("streams ready, snapshots, commands, host-calls, native show-ui, and clean shutdown", async () => {
    const dataDirectory = await createTempDir("copilot-proxy-bridge-e2e-")
    const stateDirectory = path.join(dataDirectory, "native")
    let rejectLoginItem = true

    const client = spawnBridge(
      [
        "--fixture",
        "--data-dir",
        dataDirectory,
        "--engine-path",
        engineBundlePath,
      ],
      (call) => {
        if (call.kind === "apply-login-item" && call.enabled && rejectLoginItem)
          return { ok: false, error: "Install the app first." }
        return { ok: true }
      },
    )

    const ready = await client.waitForMessage(
      (message): message is Extract<BridgeOutgoingMessage, { type: "ready" }> =>
        message.type === "ready",
    )
    expect(ready.snapshot.fixture).toBe(true)
    expect(ready.snapshot.storageMode).toBe("session-only")
    expect(ready.snapshot.settings.port).not.toBe(4141)

    const refreshed = await client.sendCommand({ kind: "refresh" })
    expect(refreshed.outcome.kind).toBe("ok")

    const saved = await client.sendCommand({
      kind: "save-settings",
      settings: { theme: "dark" },
    })
    expect(saved.outcome).toEqual({ kind: "ok" })
    expect(saved.snapshot.settings.theme).toBe("dark")
    await client.waitForMessage(
      (
        message,
      ): message is Extract<BridgeOutgoingMessage, { type: "snapshot" }> =>
        message.type === "snapshot"
        && message.snapshot.settings.theme === "dark",
    )

    const openedFolder = await client.sendCommand({
      kind: "open-config-folder",
      target: "codex",
    })
    expect(openedFolder.outcome).toEqual({ kind: "ok" })
    const folderCall = client.hostCalls.find(
      (call): call is Extract<HostCall, { kind: "open-folder" }> =>
        call.kind === "open-folder",
    )
    expect(folderCall).toBeDefined()
    if (!folderCall) throw new Error("Missing open-folder host call")
    expect((await stat(folderCall.path)).isDirectory()).toBe(true)

    const signInResponse = await client.sendCommand({ kind: "sign-in" })
    expect(signInResponse.outcome.kind).toBe("ok")
    const awaiting = await client.waitForMessage(
      (
        message,
      ): message is Extract<BridgeOutgoingMessage, { type: "snapshot" }> =>
        message.type === "snapshot"
        && message.snapshot.authorization.kind === "awaiting",
    )
    const deviceCode =
      awaiting.snapshot.authorization.kind === "awaiting" ?
        awaiting.snapshot.authorization.code
      : ""
    expect(deviceCode).toMatch(/^BRDG-\d+$/)

    const copied = await client.sendCommand({
      kind: "copy",
      target: "device-code",
    })
    expect(copied.outcome).toEqual({ kind: "ok" })
    expect(client.hostCalls).toContainEqual({
      kind: "write-clipboard",
      text: deviceCode,
    })

    const openedDevice = await client.sendCommand({ kind: "open-device-page" })
    expect(openedDevice.outcome).toEqual({ kind: "ok" })
    expect(client.hostCalls).toContainEqual({
      kind: "open-external",
      url: "https://github.com/login/device",
    })

    const failedLogin = await client.sendCommand({
      kind: "save-settings",
      settings: { launchAtLogin: true },
    })
    expect(failedLogin.outcome).toEqual({
      kind: "rejected",
      message: "Install the app first.",
    })
    expect(client.hostCalls).toContainEqual({
      kind: "apply-login-item",
      enabled: true,
    })
    expect(client.hostCalls).toContainEqual({
      kind: "apply-login-item",
      enabled: false,
    })
    rejectLoginItem = false

    if (process.platform === "darwin") {
      const session = await observeProxySession(
        await cliProxyOptions({
          homeDirectory: dataDirectory,
          stateDirectory,
        }),
      )
      expect(session.kind).toBe("managed")
      if (session.kind === "managed") {
        try {
          const result = await session.invoke({ kind: "show-ui" })
          expect(result.kind).toBe("applied")
          expect(client.hostCalls).toContainEqual({ kind: "show-ui" })
        } finally {
          await session.release()
        }
      }
    }

    client.send({ type: "shutdown" })
    const exit = await waitForExit(client)
    expect(exit.code).toBe(0)
  }, 30_000)
})

describe("built bridge.cjs encrypted vault persistence and EOF shutdown", () => {
  test("encrypted vault persists credentials-rust.enc across restart and exits cleanly on stdin EOF", async () => {
    const dataDirectory = await createTempDir("copilot-proxy-bridge-vault-")
    const cipher = createAesCipher()
    const handleHostCall = (call: HostCall): HostCallResponse => {
      if (call.kind === "vault-encrypt")
        return { ok: true, value: cipher.encrypt(call.plaintext) }
      if (call.kind === "vault-decrypt")
        return { ok: true, value: cipher.decrypt(call.ciphertext) }
      return { ok: true }
    }

    const first = spawnBridge(
      [
        "--fixture",
        "--encryption",
        "encrypted",
        "--data-dir",
        dataDirectory,
        "--engine-path",
        engineBundlePath,
      ],
      handleHostCall,
    )
    const firstReady = await first.waitForMessage(
      (message): message is Extract<BridgeOutgoingMessage, { type: "ready" }> =>
        message.type === "ready",
    )
    expect(firstReady.snapshot.storageMode).toBe("encrypted")

    await first.sendCommand({ kind: "sign-in" })
    const running = await first.waitForMessage(
      (
        message,
      ): message is Extract<BridgeOutgoingMessage, { type: "snapshot" }> =>
        message.type === "snapshot"
        && message.snapshot.account.kind === "signed-in"
        && message.snapshot.gateway.kind === "running",
      20_000,
    )
    expect(running.snapshot.account.kind).toBe("signed-in")
    expect(first.hostCalls.some((call) => call.kind === "vault-encrypt")).toBe(
      true,
    )

    const savedFiles = await readdir(dataDirectory)
    expect(savedFiles).toContain("credentials-rust.enc")
    expect(savedFiles).not.toContain("credentials.enc")

    first.send({ type: "shutdown" })
    expect((await waitForExit(first)).code).toBe(0)

    const second = spawnBridge(
      [
        "--fixture",
        "--encryption",
        "encrypted",
        "--data-dir",
        dataDirectory,
        "--engine-path",
        engineBundlePath,
      ],
      handleHostCall,
    )
    const secondReady = await second.waitForMessage(
      (message): message is Extract<BridgeOutgoingMessage, { type: "ready" }> =>
        message.type === "ready",
      15_000,
    )
    expect(second.hostCalls.some((call) => call.kind === "vault-decrypt")).toBe(
      true,
    )
    expect(secondReady.snapshot.storageMode).toBe("encrypted")

    const restored = await second.waitForMessage(
      (
        message,
      ): message is Extract<
        BridgeOutgoingMessage,
        { type: "ready" | "snapshot" }
      > => {
        const snapshot: DesktopSnapshot | undefined =
          message.type === "ready" || message.type === "snapshot" ?
            message.snapshot
          : undefined
        return snapshot?.account.kind === "signed-in"
      },
      15_000,
    )
    expect(restored.snapshot.account.kind).toBe("signed-in")

    second.closeStdin()
    const eofExit = await waitForExit(second)
    expect(eofExit.code).toBe(0)
  }, 45_000)
})
