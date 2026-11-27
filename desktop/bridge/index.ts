import { realpathSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { StringDecoder } from "node:string_decoder"
import { z } from "zod"

import type { NativePackageFileSystem } from "../../src/lib/proxy-session"
import type { ControllerOptions, DesktopController } from "../main/types"
import type { CommandResponse, DesktopSnapshot } from "../shared/contracts"

import {
  hostProxySession,
  proxyStateDirectory,
} from "../../src/lib/proxy-session"
import { createController } from "../main/controller"
import { DEVICE_PAGE } from "../main/oauth"
import { selectDataDirectory } from "../main/profile"
import { createCredentialVault } from "../main/vault"
import desktopPackage from "../package.json"
import { commandResponseSchema, snapshotSchema } from "../shared/contracts"
import { isolateFixturePort } from "../testing/settings"
import { startFixtureUpstream } from "../testing/upstream"

const SHUTDOWN_TIMEOUT_MS = 5000
const DEFAULT_HOST_CALL_TIMEOUT_MS = 15_000
const FATAL_FLUSH_TIMEOUT_MS = 250
const BRIDGE_VAULT_FILENAME = "credentials-rust.enc"

const packageFileSystem: NativePackageFileSystem = fs

export const encryptionModeSchema = z.enum(["encrypted", "session-only"])
export type BridgeEncryptionMode = z.infer<typeof encryptionModeSchema>

export const hostCallSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("vault-encrypt"), plaintext: z.string() })
    .strict(),
  z
    .object({ kind: z.literal("vault-decrypt"), ciphertext: z.string() })
    .strict(),
  z.object({ kind: z.literal("write-clipboard"), text: z.string() }).strict(),
  z.object({ kind: z.literal("open-external"), url: z.string() }).strict(),
  z.object({ kind: z.literal("open-folder"), path: z.string() }).strict(),
  z.object({ kind: z.literal("show-ui") }).strict(),
  z
    .object({ kind: z.literal("apply-login-item"), enabled: z.boolean() })
    .strict(),
])
export type HostCall = z.infer<typeof hostCallSchema>

export const bridgeOutgoingMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), snapshot: snapshotSchema }).strict(),
  z.object({ type: z.literal("snapshot"), snapshot: snapshotSchema }).strict(),
  z
    .object({
      type: z.literal("response"),
      id: z.number().int().nonnegative(),
      response: commandResponseSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("host-call"),
      id: z.number().int().nonnegative(),
      call: hostCallSchema,
    })
    .strict(),
  z.object({ type: z.literal("fatal"), message: z.string() }).strict(),
])
export type BridgeOutgoingMessage = z.infer<typeof bridgeOutgoingMessageSchema>

export const bridgeIncomingMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("command"),
      id: z.number().int().nonnegative(),
      command: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal("host-result"),
      id: z.number().int().nonnegative(),
      ok: z.boolean(),
      value: z.unknown().optional(),
      error: z.string().nullable().optional(),
    })
    .strict(),
  z.object({ type: z.literal("shutdown") }).strict(),
])
export type BridgeIncomingMessage = z.infer<typeof bridgeIncomingMessageSchema>

export interface BridgeConfig {
  dataDirectory: string
  stateDirectory: string
  enginePath: string
  version: string
  fixture: boolean
  encryption: BridgeEncryptionMode
  platform: DesktopSnapshot["platform"]
}

type BridgeLifecycleState = "starting" | "ready" | "closing" | "closed"

type VaultEncryption = NonNullable<
  Parameters<typeof createCredentialVault>[0]["encryption"]
>

export interface BridgeProtocol {
  attachController(controller: DesktopController): void
  emitReady(snapshot: DesktopSnapshot): void
  emitSnapshot(snapshot: DesktopSnapshot): void
  emitFatal(message: string): Promise<void>
  callHost(call: HostCall): Promise<unknown>
  beginShutdown(): void
  close(): void
  readonly state: BridgeLifecycleState
}

export function resolveBridgePlatform(
  platform: string = process.platform,
): DesktopSnapshot["platform"] {
  switch (platform) {
    case "darwin": {
      return "darwin"
    }
    case "win32": {
      return "win32"
    }
    case "linux": {
      return "linux"
    }
    default: {
      throw new Error("Copilot Proxy supports macOS, Windows, and Linux.")
    }
  }
}

export function defaultDataDirectory(
  platform: DesktopSnapshot["platform"],
  homeDirectory: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  switch (platform) {
    case "darwin": {
      return path.join(
        homeDirectory,
        "Library",
        "Application Support",
        "Copilot Proxy",
      )
    }
    case "win32": {
      return path.join(
        env.APPDATA || path.join(homeDirectory, "AppData", "Roaming"),
        "Copilot Proxy",
      )
    }
    case "linux": {
      return path.join(
        env.XDG_CONFIG_HOME || path.join(homeDirectory, ".config"),
        "Copilot Proxy",
      )
    }
    default: {
      const exhaustive: never = platform
      return exhaustive
    }
  }
}

function defaultEnginePath(scriptPath?: string): string {
  if (!scriptPath) return path.resolve("engine.cjs")
  let resolved = path.resolve(scriptPath)
  try {
    resolved = realpathSync(resolved)
  } catch {
    return path.join(path.dirname(resolved), "engine.cjs")
  }
  return path.join(path.dirname(resolved), "engine.cjs")
}

interface RawFlags {
  dataDir?: string
  stateDir?: string
  enginePath?: string
  version?: string
  fixture: boolean
  encryption?: string
}

const VALUE_FLAGS = new Map<
  string,
  "dataDir" | "stateDir" | "enginePath" | "version" | "encryption"
>([
  ["--data-dir", "dataDir"],
  ["--state-dir", "stateDir"],
  ["--engine-path", "enginePath"],
  ["--version", "version"],
  ["--encryption", "encryption"],
])

function readRawFlags(argv: ReadonlyArray<string>): RawFlags {
  const flags: RawFlags = { fixture: false }
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (token === "--fixture") {
      flags.fixture = true
      continue
    }
    const separator = token.indexOf("=")
    const flagName = separator === -1 ? token : token.slice(0, separator)
    const target = VALUE_FLAGS.get(flagName)
    if (!target) throw new Error(`Unknown bridge flag: ${token}`)
    const value = separator === -1 ? argv[++index] : token.slice(separator + 1)
    if (!value) throw new Error(`Missing value for ${flagName}`)
    flags[target] = value
  }
  return flags
}

function resolveDataDirectory(options: {
  explicit?: string
  fixture: boolean
  platform: DesktopSnapshot["platform"]
  homeDirectory: string
  env: Readonly<Record<string, string | undefined>>
  createFixtureDirectory?: () => string
}): string {
  if (options.explicit) return path.resolve(options.explicit)
  if (options.fixture) {
    const fixtureDirectory =
      options.createFixtureDirectory?.()
      ?? selectDataDirectory({ fixture: true })
    if (fixtureDirectory) return fixtureDirectory
  }
  return defaultDataDirectory(
    options.platform,
    options.homeDirectory,
    options.env,
  )
}

function resolveStateDirectory(options: {
  explicit?: string
  fixture: boolean
  dataDirectory: string
  homeDirectory: string
}): string {
  if (options.explicit) return path.resolve(options.explicit)
  if (options.fixture) return path.join(options.dataDirectory, "native")
  return proxyStateDirectory(options.homeDirectory)
}

export function parseBridgeArgs(
  argv: ReadonlyArray<string>,
  options: {
    platform?: string
    homeDirectory?: string
    env?: Readonly<Record<string, string | undefined>>
    scriptPath?: string
    defaultVersion?: string
    createFixtureDirectory?: () => string
  } = {},
): BridgeConfig {
  const platform = resolveBridgePlatform(options.platform ?? process.platform)
  const homeDirectory = options.homeDirectory ?? os.homedir()
  const env = options.env ?? process.env
  const raw = readRawFlags(argv)
  const encryption = encryptionModeSchema.parse(
    raw.encryption ?? "session-only",
  )
  const dataDirectory = resolveDataDirectory({
    explicit: raw.dataDir || env.COPILOT_PROXY_DATA_DIR || undefined,
    fixture: raw.fixture,
    platform,
    homeDirectory,
    env,
    createFixtureDirectory: options.createFixtureDirectory,
  })
  const stateDirectory = resolveStateDirectory({
    explicit: raw.stateDir || env.COPILOT_PROXY_STATE_DIR || undefined,
    fixture: raw.fixture,
    dataDirectory,
    homeDirectory,
  })
  const enginePath =
    raw.enginePath ?
      path.resolve(raw.enginePath)
    : defaultEnginePath(options.scriptPath)
  const version =
    raw.version ?? options.defaultVersion ?? desktopPackage.version
  return {
    dataDirectory,
    stateDirectory,
    enginePath,
    version,
    fixture: raw.fixture,
    encryption,
    platform,
  }
}

interface PendingHostCall {
  kind: HostCall["kind"]
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

function createHostCallChannel(options: {
  send(message: BridgeOutgoingMessage): void
  logError(message: string): void
  isClosing(): boolean
  timeoutMs: number
}) {
  const pending = new Map<number, PendingHostCall>()
  let sequence = 0

  return {
    call(call: HostCall): Promise<unknown> {
      if (options.isClosing())
        return Promise.reject(new Error("Bridge is shutting down."))
      const id = ++sequence
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`Host call "${call.kind}" timed out.`))
        }, options.timeoutMs)
        pending.set(id, { kind: call.kind, resolve, reject, timer })
        options.send({ type: "host-call", id, call })
      })
    },
    resolve(
      message: Extract<BridgeIncomingMessage, { type: "host-result" }>,
    ): void {
      const entry = pending.get(message.id)
      if (!entry) {
        options.logError(`Ignored unknown host-result id ${message.id}.`)
        return
      }
      clearTimeout(entry.timer)
      pending.delete(message.id)
      if (message.ok) {
        entry.resolve(message.value)
        return
      }
      const detail = message.error?.trim()
      entry.reject(
        new Error(
          detail && detail.length > 0 ?
            detail
          : `Host call "${entry.kind}" failed.`,
        ),
      )
    },
    rejectAll(reason: string): void {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(new Error(reason))
      }
      pending.clear()
    },
  }
}

type WritableChannel = NodeJS.WritableStream & {
  readonly writableEnded?: boolean
  readonly destroyed?: boolean
}

function writeFrame(
  output: WritableChannel,
  message: BridgeOutgoingMessage,
  callback?: () => void,
): void {
  if (output.writableEnded || output.destroyed) {
    callback?.()
    return
  }
  const line = `${JSON.stringify(message)}\n`
  if (callback) output.write(line, callback)
  else output.write(line)
}

function writeDiagnostic(stderr: WritableChannel, message: string): void {
  if (stderr.writableEnded || stderr.destroyed) return
  stderr.write(`[copilot-proxy-bridge] ${message}\n`)
}

function attachLineReader(options: {
  input: NodeJS.ReadableStream
  onLine(line: string): void
  onEnd(): void
}): () => void {
  const decoder = new StringDecoder("utf8")
  let buffer = ""

  function onData(chunk: Buffer | string): void {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk)
    let newlineIndex = buffer.indexOf("\n")
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex)
      buffer = buffer.slice(newlineIndex + 1)
      options.onLine(line)
      newlineIndex = buffer.indexOf("\n")
    }
  }

  function onInputEnd(): void {
    buffer += decoder.end()
    if (buffer.length > 0) {
      const remainder = buffer
      buffer = ""
      options.onLine(remainder)
    }
    options.onEnd()
  }

  function onInputClose(): void {
    options.onEnd()
  }

  options.input.on("data", onData)
  options.input.once("end", onInputEnd)
  options.input.once("close", onInputClose)
  options.input.once("error", onInputClose)
  if ("resume" in options.input && typeof options.input.resume === "function") {
    options.input.resume()
  }

  return () => {
    options.input.off("data", onData)
    options.input.off("end", onInputEnd)
    options.input.off("close", onInputClose)
    options.input.off("error", onInputClose)
  }
}

function parseIncomingLine(
  rawLine: string,
  logError: (message: string) => void,
): BridgeIncomingMessage | null {
  const line = rawLine.trim()
  if (line.length === 0) return null
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(line)
  } catch {
    logError("Ignored malformed JSON line on stdin.")
    return null
  }
  const parsed = bridgeIncomingMessageSchema.safeParse(parsedJson)
  if (!parsed.success) {
    logError("Ignored invalid protocol message on stdin.")
    return null
  }
  return parsed.data
}

function routeIncomingMessage(
  message: BridgeIncomingMessage,
  handlers: {
    onCommand(
      command: Extract<BridgeIncomingMessage, { type: "command" }>,
    ): void
    onHostResult(
      result: Extract<BridgeIncomingMessage, { type: "host-result" }>,
    ): void
    onShutdown(): void
  },
): void {
  switch (message.type) {
    case "command": {
      handlers.onCommand(message)
      return
    }
    case "host-result": {
      handlers.onHostResult(message)
      return
    }
    case "shutdown": {
      handlers.onShutdown()
      return
    }
    default: {
      const exhaustive: never = message
      return exhaustive
    }
  }
}

function flushFatalFrame(
  output: WritableChannel,
  message: string,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(done, FATAL_FLUSH_TIMEOUT_MS)
    writeFrame(output, { type: "fatal", message }, done)
  })
}

export function createBridgeProtocol(options: {
  input: NodeJS.ReadableStream
  output: WritableChannel
  stderr: WritableChannel
  hostCallTimeoutMs?: number
  onShutdown(): void
}): BridgeProtocol {
  let state: BridgeLifecycleState = "starting"
  let controller: DesktopController | null = null
  const ready = Promise.withResolvers<DesktopController>()
  void ready.promise.catch(() => undefined)
  const isClosing = () => state === "closing" || state === "closed"
  const isClosed = () => state === "closed"
  const notifyShutdown = () => options.onShutdown()

  const logError = (message: string) => writeDiagnostic(options.stderr, message)
  const send = (message: BridgeOutgoingMessage) => {
    if (isClosed()) return
    writeFrame(options.output, message)
  }
  const hostCalls = createHostCallChannel({
    send,
    logError,
    isClosing,
    timeoutMs: options.hostCallTimeoutMs ?? DEFAULT_HOST_CALL_TIMEOUT_MS,
  })

  function dispatchCommand(
    message: Extract<BridgeIncomingMessage, { type: "command" }>,
  ): void {
    void (async () => {
      try {
        const companion = controller ?? (await ready.promise)
        if (isClosing()) return
        const response: CommandResponse = await companion.execute(
          message.command,
        )
        if (isClosed()) return
        send({ type: "response", id: message.id, response })
      } catch (error) {
        if (isClosing()) return
        logError(
          `Command ${message.id} failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    })()
  }

  const detachInput = attachLineReader({
    input: options.input,
    onLine: (line) => {
      const message = parseIncomingLine(line, logError)
      if (!message) return
      routeIncomingMessage(message, {
        onCommand: dispatchCommand,
        onHostResult: (result) => hostCalls.resolve(result),
        onShutdown: notifyShutdown,
      })
    },
    onEnd: notifyShutdown,
  })

  return {
    get state() {
      return state
    },
    attachController(companion) {
      controller = companion
      ready.resolve(companion)
    },
    emitReady(snapshot) {
      if (state !== "starting") return
      state = "ready"
      send({ type: "ready", snapshot })
    },
    emitSnapshot(snapshot) {
      if (state !== "ready") return
      send({ type: "snapshot", snapshot })
    },
    emitFatal(message) {
      if (isClosed()) return Promise.resolve()
      state = "closing"
      ready.reject(new Error(message))
      hostCalls.rejectAll("Bridge encountered a fatal error.")
      return flushFatalFrame(options.output, message)
    },
    callHost: (call) => hostCalls.call(call),
    beginShutdown() {
      if (isClosing()) return
      state = "closing"
      ready.reject(new Error("Bridge is shutting down."))
      hostCalls.rejectAll("Bridge is shutting down.")
    },
    close() {
      if (isClosed()) return
      state = "closed"
      detachInput()
      ready.reject(new Error("Bridge is closed."))
      hostCalls.rejectAll("Bridge is closed.")
    },
  }
}

export function createHostVaultEncryption(
  callHost: (call: HostCall) => Promise<unknown>,
): VaultEncryption {
  return {
    async encrypt(plaintext) {
      const value = await callHost({ kind: "vault-encrypt", plaintext })
      const encoded = z.string().min(1).parse(value)
      const bytes = Buffer.from(encoded, "base64")
      if (bytes.length === 0)
        throw new Error("Host vault-encrypt returned empty ciphertext.")
      return bytes
    },
    async decrypt(ciphertextBytes) {
      const value = await callHost({
        kind: "vault-decrypt",
        ciphertext: ciphertextBytes.toString("base64"),
      })
      const plaintext = z.string().parse(value)
      return { result: plaintext, shouldReEncrypt: false }
    },
  }
}

export function createBridgeHostAdapters(
  callHost: (call: HostCall) => Promise<unknown>,
): Pick<
  ControllerOptions,
  "writeClipboard" | "openExternal" | "openFolder" | "showUi" | "applyLoginItem"
> {
  return {
    async writeClipboard(text) {
      await callHost({ kind: "write-clipboard", text })
    },
    async openExternal(url) {
      if (url !== DEVICE_PAGE)
        throw new Error("Only GitHub sign-in can be opened.")
      await callHost({ kind: "open-external", url })
    },
    async openFolder(folder) {
      await fs.mkdir(folder, { recursive: true, mode: 0o700 })
      await callHost({ kind: "open-folder", path: folder })
    },
    async showUi() {
      await callHost({ kind: "show-ui" })
    },
    async applyLoginItem(enabled) {
      await callHost({ kind: "apply-login-item", enabled })
    },
  }
}

function runCleanupStep(step: () => Promise<void> | void): Promise<void> {
  return Promise.resolve().then(step)
}

async function boundedCleanup(
  steps: ReadonlyArray<() => Promise<void> | void>,
  timeoutMs: number,
): Promise<boolean> {
  const cleanup = Promise.allSettled(steps.map((step) => runCleanupStep(step)))
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      cleanup,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true
          resolve()
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
  return !timedOut
}

function redirectConsoleToStderr(): void {
  const stderrConsole = (...args: Array<unknown>) => {
    console.error(...args)
  }
  console.log = stderrConsole
  console.info = stderrConsole
  console.warn = stderrConsole
  console.debug = stderrConsole
}

interface BridgeResources {
  controller: DesktopController | null
  stopControl?: () => Promise<void>
  stopFixture?: () => Promise<void>
  unsubscribeSnapshot?: () => void
}

async function startBridgeResources(options: {
  config: BridgeConfig
  protocol: BridgeProtocol
  resources: BridgeResources
  isShuttingDown: () => boolean
}): Promise<void> {
  const { config, protocol, resources, isShuttingDown } = options
  const fixture = config.fixture ? await startFixtureUpstream() : null
  if (fixture) resources.stopFixture = () => fixture.close()
  if (isShuttingDown()) return

  const adapters = createBridgeHostAdapters((call) => protocol.callHost(call))
  const companion = await createController({
    dataDirectory: config.dataDirectory,
    homeDirectory: config.fixture ? undefined : os.homedir(),
    stateDirectory: config.stateDirectory,
    runtimePath: config.enginePath,
    runtimeExecPath: process.execPath,
    fixtureOrigin: fixture?.origin,
    platform: config.platform,
    version: config.version,
    vault: createCredentialVault({
      directory: config.dataDirectory,
      filename: BRIDGE_VAULT_FILENAME,
      encryption:
        config.encryption === "encrypted" ?
          createHostVaultEncryption((call) => protocol.callHost(call))
        : null,
    }),
    ...adapters,
  })
  resources.controller = companion
  if (isShuttingDown()) return

  if (config.fixture) await isolateFixturePort(companion)
  if (isShuttingDown()) return

  resources.stopControl = await hostProxySession(
    {
      stateDirectory: config.stateDirectory,
      authority: companion.sessionApi(),
      showUi: adapters.showUi ?? (() => undefined),
    },
    { packageFileSystem },
  )
  if (isShuttingDown()) return

  protocol.attachController(companion)
  resources.unsubscribeSnapshot = companion.subscribe((snapshot) => {
    protocol.emitSnapshot(snapshot)
  })
  protocol.emitReady(companion.snapshot())
}

async function runBridge(argv: ReadonlyArray<string>): Promise<void> {
  redirectConsoleToStderr()
  const resources: BridgeResources = { controller: null }
  let shutdownPromise: Promise<void> | undefined
  let shuttingDown = false
  const isShuttingDown = () => shuttingDown
  let startup: Promise<void> = Promise.resolve()

  const protocol = createBridgeProtocol({
    input: process.stdin,
    output: process.stdout,
    stderr: process.stderr,
    onShutdown: () => {
      void shutdown(0)
    },
  })

  function shutdown(exitCode: number): Promise<void> {
    shuttingDown = true
    shutdownPromise ??= (async () => {
      protocol.beginShutdown()
      await boundedCleanup(
        [
          async () => {
            await startup.catch(() => undefined)
            resources.unsubscribeSnapshot?.()
            resources.unsubscribeSnapshot = undefined
            await Promise.allSettled([
              runCleanupStep(() => resources.stopControl?.()),
              runCleanupStep(() => resources.controller?.dispose()),
              runCleanupStep(() => resources.stopFixture?.()),
            ])
          },
        ],
        SHUTDOWN_TIMEOUT_MS,
      )
      protocol.close()
      process.exit(exitCode)
    })()
    return shutdownPromise
  }

  process.stdout.on("error", () => {
    void shutdown(0)
  })
  process.once("SIGTERM", () => {
    void shutdown(0)
  })
  process.once("SIGINT", () => {
    void shutdown(0)
  })

  try {
    const config = parseBridgeArgs(argv, { scriptPath: process.argv[1] })
    startup = startBridgeResources({
      config,
      protocol,
      resources,
      isShuttingDown,
    })
    await startup
  } catch (error) {
    if (isShuttingDown()) return
    const message =
      error instanceof Error ? error.message : "The bridge could not start."
    writeDiagnostic(process.stderr, message)
    await protocol.emitFatal(message)
    await shutdown(1)
  }
}

export function isBridgeEntrypoint(argv1: string | undefined): boolean {
  if (!argv1) return false
  const resolved = path.resolve(argv1)
  const base = path.basename(resolved)
  return (
    base === "bridge.cjs"
    || base === "bridge.mjs"
    || base === "bridge.js"
    || (base === "index.ts"
      && path.basename(path.dirname(resolved)) === "bridge")
  )
}

if (isBridgeEntrypoint(process.argv[1])) {
  void runBridge(process.argv.slice(2))
}
