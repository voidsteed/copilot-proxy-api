import { spawn } from "node:child_process"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import { createServer, type Socket } from "node:net"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { z } from "zod"

import type {
  HostProxySessionOptions,
  ManagedSession,
  NativeCredentialProvenance,
  OpenProxySessionOptions,
  ProxySession,
} from "./proxy-contracts"

import { inspectAgentConfigs } from "./agent-config"
import { discoverLegacySession, legacyIntentCompatible } from "./legacy-proxy"
import {
  nativeCredentialProvenanceSchema,
  nativeIntentSchema,
  runtimeOptionsSchema,
} from "./proxy-contracts"
import {
  acceptProxyClient,
  clearUnavailablePrivateControl,
  connectProxyClient,
  MAX_REQUEST_BYTES,
  PROTOCOL_VERSION,
  publisherAddressSchema,
  readUnavailablePrivateControl,
  secretMatches,
  storeUnavailablePrivateControl,
} from "./proxy-session-wire"

const REGISTRATION_TIMEOUT_MS = 15_000
const { publisherId: publisherIdSchema, nonce: nonceSchema } =
  publisherAddressSchema.shape
const recordSchema = z
  .object({
    kind: z.literal("copilot-proxy-native-session"),
    protocol: z.literal(PROTOCOL_VERSION),
    publisherId: publisherIdSchema,
    nonce: nonceSchema,
    pid: z.number().int().positive(),
    socketPath: z.string().min(1).max(4096),
  })
  .strict()
type SessionRecord = z.infer<typeof recordSchema>
const installationSchema = z
  .object({
    kind: z.literal("copilot-proxy-native-installation"),
    protocol: z.literal(PROTOCOL_VERSION),
    executablePath: z.string().min(1).max(4096),
    packageFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
type Installation = z.infer<typeof installationSchema>
export type NativePackageFileSystem = Readonly<
  Pick<typeof fs, "realpath" | "readFile" | "lstat" | "readdir" | "open">
>
export type NativeControlCapability =
  | { kind: "supported"; platform: "darwin"; transport: "unix-socket" }
  | {
      kind: "unsupported"
      platform: Exclude<NodeJS.Platform, "darwin">
      message: string
    }

export function nativeControlCapability(
  options: { platform?: NodeJS.Platform } = {},
): NativeControlCapability {
  const platform = options.platform ?? process.platform
  if (platform === "darwin")
    return { kind: "supported", platform, transport: "unix-socket" }
  if (platform === "win32")
    return {
      kind: "unsupported",
      platform,
      message:
        "Private CLI control is unavailable on Windows until native state and named-pipe ownership can be verified. Use Copilot Proxy desktop.",
    }
  if (platform === "linux")
    return {
      kind: "unsupported",
      platform,
      message:
        "Private CLI control is unavailable on Linux until the installed launcher and AppImage package can be verified after closing the app. Use Copilot Proxy desktop.",
    }
  return {
    kind: "unsupported",
    platform,
    message:
      "Private CLI control is unavailable on this platform. Use Copilot Proxy desktop.",
  }
}
export function proxyStateDirectory(homeDirectory: string): string {
  return path.join(
    homeDirectory,
    ".local",
    "share",
    "copilot-proxy-api",
    "native",
  )
}

export function requireDefaultStandaloneProfile(homeDirectory: string): void {
  if (path.resolve(homeDirectory) !== path.resolve(homedir()))
    throw new Error(
      "The selected native profile has no available authority. Standalone CLI authentication uses the standard user home.",
    )
}

export async function cliProxyOptions(
  options: {
    homeDirectory?: string
    stateDirectory?: string
  } = {},
): Promise<Omit<OpenProxySessionOptions, "intent">> {
  const homeDirectory = options.homeDirectory ?? homedir()
  return {
    homeDirectory,
    stateDirectory:
      options.stateDirectory ?? proxyStateDirectory(homeDirectory),
    discovery: {
      configuredAgents: await inspectAgentConfigs({
        homeDirectory,
        connection: null,
        catalog: [],
        proposals: { "claude-code": null, codex: null, opencode: null },
      }),
      savedRuntime: runtimeOptionsSchema.parse({
        port: 4141,
        accountType: "individual",
        manualApprove: false,
        rateLimitSeconds: null,
        rateLimitWait: false,
        responsesContextTrim: false,
        proxyFromEnvironment: false,
      }),
    },
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

async function privateDirectory(
  directory: string,
  create = false,
): Promise<string> {
  if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const canonical = await fs.realpath(directory)
  const stats = await fs.stat(canonical)
  if (
    !stats.isDirectory()
    || (process.getuid && stats.uid !== process.getuid())
    || (stats.mode & 0o077) !== 0
  )
    throw new Error(
      "The native proxy state directory must be owned by this user and private.",
    )
  return canonical
}

async function privateJson(filename: string): Promise<unknown> {
  const stats = await fs.lstat(filename)
  if (
    !stats.isFile()
    || (process.getuid && stats.uid !== process.getuid())
    || (stats.mode & 0o077) !== 0
    || stats.size > MAX_REQUEST_BYTES
  )
    throw new Error("The native proxy record is not a private regular file.")
  const text = new TextDecoder(undefined, { fatal: true }).decode(
    await fs.readFile(filename),
  )
  return JSON.parse(text)
}

async function optionalJson(filename: string): Promise<unknown> {
  try {
    return await privateJson(filename)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

async function atomicPrivateJson(
  filename: string,
  value: unknown,
): Promise<void> {
  await optionalJson(filename)
  const temporary = `${filename}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify(value), {
      mode: 0o600,
      flag: "wx",
    })
    await fs.rename(temporary, filename)
  } finally {
    await fs.unlink(temporary).catch((error: unknown) => {
      if (!isMissing(error)) throw error
    })
  }
}

export async function writeNativeCredentialProvenance(
  options: {
    stateDirectory: string
    provenance: NativeCredentialProvenance
  },
  environment: { platform?: NodeJS.Platform } = {},
): Promise<void> {
  const provenance = nativeCredentialProvenanceSchema.parse(options.provenance)
  const capability = nativeControlCapability(environment)
  if (capability.kind === "unsupported")
    return storeUnavailablePrivateControl({
      stateDirectory: options.stateDirectory,
      platform: capability.platform,
      provenance,
    })
  const directory = await privateDirectory(options.stateDirectory, true)
  await atomicPrivateJson(
    path.join(directory, "credential-provenance.json"),
    provenance,
  )
}

async function hashFile(
  hash: ReturnType<typeof createHash>,
  filename: string,
  packageFileSystem: NativePackageFileSystem,
): Promise<void> {
  const stats = await packageFileSystem.lstat(filename)
  if (!stats.isFile() || (stats.mode & 0o022) !== 0)
    throw new Error("The registered native package contains an unsafe file.")
  hash.update(path.basename(filename))
  hash.update(String(stats.size))
  const handle = await packageFileSystem.open(filename, "r")
  try {
    const buffer = Buffer.alloc(64 * 1024)
    while (true) {
      const { bytesRead } = await handle.read(buffer)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    await handle.close().catch(() => {})
  }
}

async function hashUnpackedResources({
  hash,
  directory,
  packageFileSystem,
  relative = "",
}: {
  hash: ReturnType<typeof createHash>
  directory: string
  packageFileSystem: NativePackageFileSystem
  relative?: string
}): Promise<void> {
  const entries = await packageFileSystem.readdir(directory, {
    withFileTypes: true,
  })
  entries.sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    const filename = path.join(directory, entry.name)
    const entryPath = path.join(relative, entry.name)
    hash.update(
      JSON.stringify({ entry: entryPath, directory: entry.isDirectory() }),
    )
    if (entry.isDirectory())
      await hashUnpackedResources({
        hash,
        directory: filename,
        packageFileSystem,
        relative: entryPath,
      })
    else if (entry.isFile()) await hashFile(hash, filename, packageFileSystem)
    else
      throw new Error("The registered native resources contain an unsafe link.")
  }
}

export async function nativePackageFingerprint(
  executablePath: string,
  packageFileSystem: NativePackageFileSystem = fs,
): Promise<string> {
  if (!path.isAbsolute(executablePath))
    throw new Error("The registered native executable must be absolute.")
  const executable = await packageFileSystem.realpath(executablePath)
  const mac =
    path.basename(executable) === "Copilot Proxy"
    && path.basename(path.dirname(executable)) === "MacOS"
  const contents =
    mac ? path.dirname(path.dirname(executable)) : path.dirname(executable)
  const resources = path.join(contents, mac ? "Resources" : "resources")
  if (mac) {
    if (
      path.basename(contents) !== "Contents"
      || path.basename(path.dirname(contents)) !== "Copilot Proxy.app"
    )
      throw new Error("The registered native app has the wrong identity.")
    const plist = await packageFileSystem.readFile(
      path.join(contents, "Info.plist"),
      "utf8",
    )
    if (
      !/<key>CFBundleIdentifier<\/key>\s*<string>com\.voidsteed\.copilotproxy<\/string>/.test(
        plist,
      )
      || !/<key>CFBundleExecutable<\/key>\s*<string>Copilot Proxy<\/string>/.test(
        plist,
      )
    )
      throw new Error(
        "The registered native app has the wrong bundle identity.",
      )
  } else if (
    !["copilot-proxy", "copilot-proxy.exe"].includes(path.basename(executable))
  ) {
    throw new Error("Only the fixed Copilot Proxy executable can be enrolled.")
  }
  const hash = createHash("sha256")
  hash.update("copilot-proxy-native-package-v1")
  await hashFile(hash, executable, packageFileSystem)
  if (mac)
    await hashFile(hash, path.join(contents, "Info.plist"), packageFileSystem)
  await hashFile(hash, path.join(resources, "app.asar"), packageFileSystem)
  const unpacked = path.join(resources, "app.asar.unpacked")
  const engine = await packageFileSystem.lstat(
    path.join(unpacked, "dist", "engine.cjs"),
  )
  if (!engine.isFile())
    throw new Error("The registered native engine is missing.")
  await hashUnpackedResources({
    hash,
    directory: unpacked,
    packageFileSystem,
  })
  return hash.digest("hex")
}

async function validatedInstallation(
  value: unknown,
  packageFileSystem: NativePackageFileSystem = fs,
): Promise<Installation> {
  const installation = installationSchema.parse(value)
  if (
    (await nativePackageFingerprint(
      installation.executablePath,
      packageFileSystem,
    )) !== installation.packageFingerprint
  )
    throw new Error(
      "The registered Copilot Proxy package changed. Open the verified app before using the CLI.",
    )
  return installation
}

async function socketLocation(
  directory: string,
): Promise<{ socketPath: string; alias: string | null }> {
  if (process.platform === "win32") {
    const identity = createHash("sha256").update(directory).digest("hex")
    return { socketPath: `\\\\.\\pipe\\copilot-proxy-${identity}`, alias: null }
  }
  const direct = path.join(directory, "control.sock")
  if (Buffer.byteLength(direct) < 104)
    return { socketPath: direct, alias: null }
  const temporaryRoot = Buffer.byteLength(tmpdir()) < 40 ? tmpdir() : "/tmp"
  const aliasDirectory = await privateDirectory(
    path.join(temporaryRoot, `copilot-proxy-${process.getuid?.() ?? "user"}`),
    true,
  )
  const alias = path.join(
    aliasDirectory,
    createHash("sha256").update(directory).digest("hex").slice(0, 24),
  )
  try {
    await fs.symlink(directory, alias)
  } catch (error) {
    if (
      !(error instanceof Error)
      || !("code" in error)
      || error.code !== "EEXIST"
    )
      throw error
    const existing = await fs.lstat(alias)
    if (
      !existing.isSymbolicLink()
      || (process.getuid && existing.uid !== process.getuid())
      || (await fs.realpath(alias)) !== directory
    )
      throw new Error("The private socket alias belongs to another location.")
  }
  return { socketPath: path.join(alias, "control.sock"), alias }
}

async function validateSocketLocation(
  record: SessionRecord,
  publisherDirectory: string,
): Promise<void> {
  if (process.platform === "win32") {
    const expected = `\\\\.\\pipe\\copilot-proxy-${createHash("sha256").update(publisherDirectory).digest("hex")}`
    if (record.socketPath !== expected)
      throw new Error("Invalid native named pipe location.")
    return
  }
  if (path.basename(record.socketPath) !== "control.sock")
    throw new Error("The native socket has an invalid name.")
  const parent = await fs
    .realpath(path.dirname(record.socketPath))
    .catch((error: unknown) => {
      if (isMissing(error)) return null
      throw error
    })
  if (parent === null) return
  if (parent !== publisherDirectory)
    throw new Error(
      "The native socket is outside its private publisher directory.",
    )
  const stats = await fs.lstat(record.socketPath).catch((error: unknown) => {
    if (isMissing(error)) return null
    throw error
  })
  if (
    stats
    && (!stats.isSocket()
      || (process.getuid && stats.uid !== process.getuid())
      || (stats.mode & 0o077) !== 0)
  )
    throw new Error("The native socket is not user-only.")
}

async function removeSocketAlias(
  alias: string | null,
  publisherDirectory: string,
): Promise<void> {
  if (!alias) return
  const target = await fs.readlink(alias).catch((error: unknown) => {
    if (isMissing(error)) return null
    throw error
  })
  if (target === null) return
  if (target !== publisherDirectory)
    throw new Error("The native socket alias changed during disposal.")
  await fs.unlink(alias)
}

async function sessionRecords(
  directory: string,
): Promise<Array<SessionRecord>> {
  const root = path.join(directory, "sessions")
  const entries = await fs
    .readdir(root, { withFileTypes: true })
    .catch((error: unknown) => {
      if (isMissing(error)) return []
      throw error
    })
  const records: Array<SessionRecord> = []
  for (const entry of entries) {
    const id = publisherIdSchema.parse(entry.name)
    if (!entry.isDirectory())
      throw new Error("Invalid native proxy publisher directory.")
    const publisherDirectory = await privateDirectory(path.join(root, id))
    const recordValue = await optionalJson(
      path.join(publisherDirectory, "control.json"),
    )
    if (recordValue === undefined) continue
    const record = recordSchema.parse(recordValue)
    if (record.publisherId !== id)
      throw new Error("Invalid native proxy publisher identity.")
    await validateSocketLocation(record, publisherDirectory)
    records.push(record)
  }
  return records
}

async function activeNative(directory: string): Promise<ManagedSession | null> {
  const records = await sessionRecords(directory)
  let active: ManagedSession | null = null
  for (const record of records) {
    const session = connectProxyClient(record)
    try {
      await session.read()
      if (active) {
        await session.release()
        await active.release()
        throw new Error(
          "More than one native Copilot Proxy controller is active.",
        )
      }
      active = session
    } catch (error) {
      await session.release()
      if (
        error instanceof Error
        && "code" in error
        && ["ECONNREFUSED", "ENOENT"].includes(String(error.code))
      )
        continue
      throw error
    }
  }
  return active
}

async function wakeNative(
  installation: Installation,
  directory: string,
): Promise<ManagedSession> {
  await validatedInstallation(installation)
  const child = spawn(installation.executablePath, ["--background"], {
    detached: true,
    stdio: "ignore",
    shell: false,
  })
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve)
    child.once("error", reject)
  })
  child.unref()
  const deadline = Date.now() + REGISTRATION_TIMEOUT_MS
  while (Date.now() < deadline) {
    const session = await activeNative(directory)
    if (session) return session
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(
    "The registered Copilot Proxy app did not open its private channel. Open the app to recover it.",
  )
}

export async function observeProxySession(
  options: Omit<OpenProxySessionOptions, "intent">,
): Promise<ProxySession> {
  return discoverSession(options)
}

async function discoverSession(
  options: Omit<OpenProxySessionOptions, "intent">,
  intent?: OpenProxySessionOptions["intent"],
): Promise<ProxySession> {
  try {
    const unavailablePlatform = await readUnavailablePrivateControl(
      options.stateDirectory,
    )
    if (unavailablePlatform !== null) {
      const capability = nativeControlCapability({
        platform: unavailablePlatform,
      })
      return {
        kind: "unavailable",
        message:
          capability.kind === "unsupported" ?
            capability.message
          : "Native CLI control is unavailable.",
      }
    }
    const directory = await privateDirectory(options.stateDirectory).catch(
      (error: unknown) => {
        if (isMissing(error)) return null
        throw error
      },
    )
    if (directory) {
      const registered = await optionalJson(
        path.join(directory, "installation.json"),
      )
      const installation =
        registered === undefined ? null : (
          await validatedInstallation(registered)
        )
      const active = await activeNative(directory)
      if (active) return active
      if (installation) return await wakeNative(installation, directory)
      const provenance = await optionalJson(
        path.join(directory, "credential-provenance.json"),
      )
      if (provenance !== undefined) {
        nativeCredentialProvenanceSchema.parse(provenance)
        return {
          kind: "unavailable",
          message:
            "This account uses native Copilot Proxy storage. Open the verified app to restore its private channel.",
        }
      }
      if (
        (
          await fs
            .readdir(path.join(directory, "sessions"))
            .catch((error: unknown) => {
              if (isMissing(error)) return []
              throw error
            })
        ).length > 0
      )
        return {
          kind: "unavailable",
          message:
            "The known native Copilot Proxy controller is unavailable. Open the verified app before using the CLI.",
        }
    }
    return await discoverLegacySession(options, intent)
  } catch (error) {
    return {
      kind: "unavailable",
      message:
        error instanceof Error ?
          error.message
        : "Native Copilot Proxy discovery failed.",
    }
  }
}

export async function openProxySession(
  options: OpenProxySessionOptions,
): Promise<ProxySession> {
  const intent = nativeIntentSchema.parse(options.intent)
  if (intent.kind !== "ensure-running")
    return {
      kind: "unavailable",
      message: "CLI startup requires an ensure-running intent.",
    }
  const session = await discoverSession(options, intent)
  if (session.kind === "standalone" || session.kind === "unavailable")
    return session
  try {
    const snapshot = await session.read()
    if (snapshot.kind === "legacy") {
      if (await legacyIntentCompatible(intent, snapshot)) return session
      await session.release()
      return {
        kind: "unavailable",
        message:
          "The existing CLI is read-only. Stop it normally before changing its account or runtime through Copilot Proxy.",
      }
    }
    if (session.kind !== "managed") return session
    const result = await session.invoke(intent)
    if (result.kind === "applied") {
      const lease = result.createdGateway
      if (!lease) return session
      return {
        ...session,
        lifecycle: {
          kind: "creator",
          lease,
          stopCreatedGateway: () =>
            session.invoke({
              kind: "stop-gateway",
              expected: lease,
              timeoutMs: 15_000,
            }),
        },
      }
    }
    if (
      result.kind === "session-changed"
      && result.snapshot.kind === "legacy"
      && (await legacyIntentCompatible(intent, result.snapshot))
    )
      return session
    await session.release()
    return {
      kind: "unavailable",
      message:
        result.kind === "unavailable" ?
          result.message
        : "The active proxy changed while starting. Run the command again.",
    }
  } catch (error) {
    await session.release()
    return {
      kind: "unavailable",
      message:
        error instanceof Error ?
          error.message
        : "Could not start the native proxy.",
    }
  }
}

export async function hostProxySession(
  options: HostProxySessionOptions,
  environment: {
    platform?: NodeJS.Platform
    packageFileSystem?: NativePackageFileSystem
  } = {},
): Promise<() => Promise<void>> {
  const capability = nativeControlCapability(environment)
  if (capability.kind === "unsupported") {
    await storeUnavailablePrivateControl({
      stateDirectory: options.stateDirectory,
      platform: capability.platform,
    })
    return () => Promise.resolve()
  }
  const directory = await privateDirectory(options.stateDirectory, true)
  const existing = await activeNative(directory)
  if (existing) {
    await existing.release()
    throw new Error("A native Copilot Proxy controller is already active.")
  }
  const installation =
    options.installation ?
      await validatedInstallation(
        {
          kind: "copilot-proxy-native-installation",
          protocol: PROTOCOL_VERSION,
          ...options.installation,
        },
        environment.packageFileSystem,
      )
    : null
  const publisherId = randomUUID().replaceAll("-", "")
  const publisherDirectory = await privateDirectory(
    path.join(directory, "sessions", publisherId),
    true,
  )
  const location = await socketLocation(publisherDirectory)
  const record: SessionRecord = {
    kind: "copilot-proxy-native-session",
    protocol: PROTOCOL_VERSION,
    publisherId,
    nonce: randomBytes(32).toString("hex"),
    pid: process.pid,
    socketPath: location.socketPath,
  }
  const clients = new Set<Socket>()
  const server = createServer((socket) => {
    clients.add(socket)
    socket.once("close", () => clients.delete(socket))
    acceptProxyClient(socket, record, options)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(record.socketPath, () => {
        server.removeListener("error", reject)
        resolve()
      })
    })
    if (process.platform !== "win32") await fs.chmod(record.socketPath, 0o600)
    await atomicPrivateJson(
      path.join(publisherDirectory, "control.json"),
      record,
    )
    if (installation)
      await atomicPrivateJson(
        path.join(directory, "installation.json"),
        installation,
      )
    await clearUnavailablePrivateControl(directory)
  } catch (error) {
    server.close()
    for (const client of clients) client.destroy()
    await fs.rm(publisherDirectory, { recursive: true, force: true })
    await removeSocketAlias(location.alias, publisherDirectory)
    throw error
  }
  let closed = false
  return async () => {
    if (closed) return
    closed = true
    for (const client of clients) client.destroy()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
    const current = recordSchema.parse(
      await privateJson(path.join(publisherDirectory, "control.json")),
    )
    if (
      current.publisherId !== record.publisherId
      || !secretMatches(current.nonce, record.nonce)
    )
      throw new Error("The native publisher record changed during disposal.")
    await removeSocketAlias(location.alias, publisherDirectory)
    await fs.rm(publisherDirectory, { recursive: true })
  }
}
