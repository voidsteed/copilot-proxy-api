import { spawn } from "node:child_process"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import { createServer, type Socket } from "node:net"
import { homedir } from "node:os"
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
import { discoverLegacySession } from "./legacy-proxy"
import {
  agentModelChoicesSchema,
  nativeCredentialProvenanceSchema,
  nativeIntentSchema,
  runtimeOptionsSchema,
} from "./proxy-contracts"
import {
  attachCreatorLifecycle,
  canFallBackToStandalone,
  resolveBrokerLegacySnapshot,
  resolveDirectLegacySession,
} from "./proxy-session-legacy"
import {
  acceptProxyClient,
  assertPrivateRegularFile,
  atomicPrivateJson,
  clearUnavailablePrivateControl,
  connectProxyClient,
  isMissing,
  isPrivateUserDirectory,
  MAX_REQUEST_BYTES,
  optionalJson,
  privateDirectory,
  privateJson,
  PROTOCOL_VERSION,
  prunePublisherDirectory,
  publisherAddressSchema,
  readUnavailablePrivateControl,
  removeSocketAlias,
  secretMatches,
  socketLocation,
  storeUnavailablePrivateControl,
  validateSocketLocation,
} from "./proxy-session-wire"

const REGISTRATION_TIMEOUT_MS = 15_000
const INITIALIZING_GRACE_MS = 10_000
const STALE_SOCKET_CODES = new Set([
  "ECONNREFUSED",
  "ENOENT",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ECONNABORTED",
])

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      if (error.code === "ESRCH") return false
      if (error.code === "EPERM") return true
    }
    return true
  }
}

function isStaleSocketError(error: unknown): boolean {
  return (
    error instanceof Error
    && "code" in error
    && STALE_SOCKET_CODES.has(String(error.code))
  )
}
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
        proposals: agentModelChoicesSchema.parse({}),
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

async function readSessionsRoot(directory: string) {
  const root = path.join(directory, "sessions")
  const stats = await fs.lstat(root).catch((error: unknown) => {
    if (isMissing(error)) return null
    throw error
  })
  if (!stats) return null
  if (!isPrivateUserDirectory(stats))
    throw new Error(
      "The native proxy state directory must be owned by this user and private.",
    )
  return { root, entries: await fs.readdir(root, { withFileTypes: true }) }
}

async function hasRemainingPublisherSessions(
  directory: string,
): Promise<boolean> {
  const sessions = await readSessionsRoot(directory)
  if (!sessions) return false
  for (const entry of sessions.entries) {
    if (publisherIdSchema.safeParse(entry.name).success) return true
    if (!entry.isFile())
      throw new Error("Invalid native proxy publisher directory.")
  }
  return false
}

async function readSessionRecord(
  controlPath: string,
  publisherId: string,
): Promise<SessionRecord | null> {
  const exists = await assertPrivateRegularFile(controlPath, {
    allowMissing: true,
  })
  if (!exists) return null
  const stats = await fs.lstat(controlPath).catch((error: unknown) => {
    if (isMissing(error)) return null
    throw error
  })
  if (!stats || stats.size > MAX_REQUEST_BYTES) return null
  try {
    const text = new TextDecoder(undefined, { fatal: true }).decode(
      await fs.readFile(controlPath),
    )
    const parsed = recordSchema.safeParse(JSON.parse(text))
    if (!parsed.success || parsed.data.publisherId !== publisherId) return null
    return parsed.data
  } catch {
    return null
  }
}

interface DiscoveredSessionRecord {
  record: SessionRecord
  publisherDirectory: string
}

async function sessionRecords(
  directory: string,
  options: { pruneStale?: boolean } = {},
): Promise<Array<DiscoveredSessionRecord>> {
  const sessions = await readSessionsRoot(directory)
  if (!sessions) return []
  const records: Array<DiscoveredSessionRecord> = []
  for (const entry of sessions.entries) {
    const parsedId = publisherIdSchema.safeParse(entry.name)
    if (!parsedId.success) {
      if (entry.isFile()) continue
      throw new Error("Invalid native proxy publisher directory.")
    }
    if (!entry.isDirectory())
      throw new Error("Invalid native proxy publisher directory.")
    const id = parsedId.data
    const entryPath = path.join(sessions.root, id)
    const dirStats = await fs.lstat(entryPath).catch((error: unknown) => {
      if (isMissing(error)) return null
      throw error
    })
    if (!dirStats) continue
    if (!isPrivateUserDirectory(dirStats))
      throw new Error(
        "The native proxy state directory must be owned by this user and private.",
      )
    const publisherDirectory = await privateDirectory(entryPath)
    const record = await readSessionRecord(
      path.join(publisherDirectory, "control.json"),
      id,
    )
    if (record === null) {
      if (
        options.pruneStale
        && Date.now() - dirStats.mtimeMs >= INITIALIZING_GRACE_MS
      )
        await prunePublisherDirectory(publisherDirectory)
      continue
    }
    await validateSocketLocation(record.socketPath, publisherDirectory)
    records.push({ record, publisherDirectory })
  }
  return records
}

async function activeNative(
  directory: string,
  options: { pruneStale?: boolean } = { pruneStale: true },
): Promise<ManagedSession | null> {
  const records = await sessionRecords(directory, options)
  let active: ManagedSession | null = null
  for (const { record, publisherDirectory } of records) {
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
        options.pruneStale
        && isStaleSocketError(error)
        && !isPidAlive(record.pid)
      ) {
        await prunePublisherDirectory(publisherDirectory, record.socketPath)
        continue
      }
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
      const active = await activeNative(directory)
      if (active) return active
      const registered = await optionalJson(
        path.join(directory, "installation.json"),
      )
      const installation =
        registered === undefined ? null : (
          await validatedInstallation(registered)
        )
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
      if (await hasRemainingPublisherSessions(directory))
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
    if (session.kind === "legacy")
      return await resolveDirectLegacySession(session, intent)
    const result = await session.invoke(intent)
    if (result.kind === "applied") {
      return result.createdGateway ?
          attachCreatorLifecycle(session, result.createdGateway)
        : session
    }
    if (
      result.kind === "session-changed"
      && result.snapshot.kind === "legacy"
    ) {
      return await resolveBrokerLegacySnapshot({
        session,
        intent,
        snapshot: result.snapshot,
      })
    }
    if (
      result.kind === "unavailable"
      && (await canFallBackToStandalone({
        stateDirectory: options.stateDirectory,
        intent,
        session,
      }))
    ) {
      await session.release()
      return { kind: "standalone" }
    }
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
