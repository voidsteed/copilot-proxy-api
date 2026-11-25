import { createHash, randomUUID, timingSafeEqual } from "node:crypto"
import fs from "node:fs/promises"
import { createConnection, type Socket } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { z } from "zod"

import type {
  HostProxySessionOptions,
  ManagedSession,
  NativeCredentialProvenance,
  ServiceSnapshot,
} from "./proxy-contracts"

import {
  controlResultSchema,
  nativeConnectionSchema,
  nativeIntentSchema,
  serviceSnapshotSchema,
} from "./proxy-contracts"

export const PROTOCOL_VERSION = 1
export const MAX_REQUEST_BYTES = 64 * 1024
const MAX_RESPONSE_BYTES = 1024 * 1024
const CONNECT_TIMEOUT_MS = 2000
const READ_TIMEOUT_MS = 10_000
const INVOKE_TIMEOUT_MS = 65_000
const unavailablePlatformSchema = z.enum([
  "aix",
  "android",
  "freebsd",
  "haiku",
  "linux",
  "openbsd",
  "sunos",
  "win32",
  "cygwin",
  "netbsd",
])
const unavailableControlSchema = z
  .object({
    kind: z.literal("copilot-proxy-native-control-unavailable"),
    protocol: z.literal(PROTOCOL_VERSION),
    platform: unavailablePlatformSchema,
  })
  .strict()
const unavailableControlName = "native-control-unavailable.json"

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

export function isPrivateUserDirectory(stats: {
  isDirectory(): boolean
  uid: number
  mode: number
}): boolean {
  return (
    stats.isDirectory()
    && (!process.getuid || stats.uid === process.getuid())
    && (stats.mode & 0o077) === 0
  )
}

export async function privateDirectory(
  directory: string,
  create = false,
): Promise<string> {
  if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const canonical = await fs.realpath(directory)
  const stats = await fs.stat(canonical)
  if (!isPrivateUserDirectory(stats))
    throw new Error(
      "The native proxy state directory must be owned by this user and private.",
    )
  return canonical
}

export async function assertPrivateRegularFile(
  filename: string,
  options: { allowMissing?: boolean; maxBytes?: number } = {},
): Promise<boolean> {
  const stats = await fs.lstat(filename).catch((error: unknown) => {
    if (options.allowMissing && isMissing(error)) return null
    throw error
  })
  if (!stats) return false
  if (
    !stats.isFile()
    || (process.getuid && stats.uid !== process.getuid())
    || (stats.mode & 0o077) !== 0
    || (options.maxBytes !== undefined && stats.size > options.maxBytes)
  )
    throw new Error("The native proxy record is not a private regular file.")
  return true
}

export async function privateJson(filename: string): Promise<unknown> {
  await assertPrivateRegularFile(filename, { maxBytes: MAX_REQUEST_BYTES })
  const text = new TextDecoder(undefined, { fatal: true }).decode(
    await fs.readFile(filename),
  )
  return JSON.parse(text)
}

export async function optionalJson(filename: string): Promise<unknown> {
  try {
    return await privateJson(filename)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

export async function atomicPrivateJson(
  filename: string,
  value: unknown,
): Promise<void> {
  await assertPrivateRegularFile(filename, { allowMissing: true })
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

function aliasDirectoryPath(): string {
  const temporaryRoot = Buffer.byteLength(tmpdir()) < 40 ? tmpdir() : "/tmp"
  return path.join(
    temporaryRoot,
    `copilot-proxy-${process.getuid?.() ?? "user"}`,
  )
}

function aliasFilename(aliasDirectory: string, directory: string): string {
  return path.join(
    aliasDirectory,
    createHash("sha256").update(directory).digest("hex").slice(0, 24),
  )
}

export async function socketLocation(
  directory: string,
): Promise<{ socketPath: string; alias: string | null }> {
  if (process.platform === "win32") {
    const identity = createHash("sha256").update(directory).digest("hex")
    return { socketPath: `\\\\.\\pipe\\copilot-proxy-${identity}`, alias: null }
  }
  const direct = path.join(directory, "control.sock")
  if (Buffer.byteLength(direct) < 104)
    return { socketPath: direct, alias: null }
  const aliasDirectory = await privateDirectory(aliasDirectoryPath(), true)
  const alias = aliasFilename(aliasDirectory, directory)
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

export async function validateSocketLocation(
  socketPath: string,
  publisherDirectory: string,
): Promise<void> {
  if (process.platform === "win32") {
    const expected = `\\\\.\\pipe\\copilot-proxy-${createHash("sha256").update(publisherDirectory).digest("hex")}`
    if (socketPath !== expected)
      throw new Error("Invalid native named pipe location.")
    return
  }
  if (path.basename(socketPath) !== "control.sock")
    throw new Error("The native socket has an invalid name.")
  const parent = await fs
    .realpath(path.dirname(socketPath))
    .catch((error: unknown) => {
      if (isMissing(error)) return null
      throw error
    })
  if (parent === null) return
  if (parent !== publisherDirectory)
    throw new Error(
      "The native socket is outside its private publisher directory.",
    )
  const stats = await fs.lstat(socketPath).catch((error: unknown) => {
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

export async function removeSocketAlias(
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

async function pruneSocketAlias(
  alias: string | null,
  publisherDirectory: string,
): Promise<void> {
  if (!alias) return
  const stats = await fs.lstat(alias).catch((error: unknown) => {
    if (isMissing(error)) return null
    throw error
  })
  if (
    !stats
    || !stats.isSymbolicLink()
    || (process.getuid && stats.uid !== process.getuid())
  )
    return
  const target = await fs.readlink(alias).catch((error: unknown) => {
    if (isMissing(error)) return null
    throw error
  })
  if (target !== publisherDirectory) return
  await fs.unlink(alias).catch((error: unknown) => {
    if (!isMissing(error)) throw error
  })
}

export async function prunePublisherDirectory(
  publisherDirectory: string,
  socketPath?: string,
): Promise<void> {
  const stats = await fs.lstat(publisherDirectory).catch((error: unknown) => {
    if (isMissing(error)) return null
    throw error
  })
  if (!stats) return
  if (!isPrivateUserDirectory(stats))
    throw new Error(
      "The native proxy state directory must be owned by this user and private.",
    )
  const recordAlias =
    socketPath && process.platform !== "win32" ? path.dirname(socketPath) : null
  if (recordAlias && recordAlias !== publisherDirectory)
    await pruneSocketAlias(recordAlias, publisherDirectory)
  if (
    process.platform !== "win32"
    && Buffer.byteLength(path.join(publisherDirectory, "control.sock")) >= 104
  ) {
    const aliasDirectory = await privateDirectory(aliasDirectoryPath()).catch(
      (error: unknown) => {
        if (isMissing(error)) return null
        throw error
      },
    )
    const expectedAlias =
      aliasDirectory ? aliasFilename(aliasDirectory, publisherDirectory) : null
    if (expectedAlias && expectedAlias !== recordAlias)
      await pruneSocketAlias(expectedAlias, publisherDirectory)
  }
  await fs.rm(publisherDirectory, { recursive: true, force: true })
}

export async function readUnavailablePrivateControl(
  stateDirectory: string,
): Promise<Exclude<NodeJS.Platform, "darwin"> | null> {
  const filename = path.join(stateDirectory, unavailableControlName)
  const stats = await fs.lstat(filename).catch((error: unknown) => {
    if (isMissing(error)) return null
    throw error
  })
  if (!stats) return null
  if (!stats.isFile() || stats.size > 1024)
    throw new Error("The native control capability record is invalid.")
  const text = new TextDecoder(undefined, { fatal: true }).decode(
    await fs.readFile(filename),
  )
  return unavailableControlSchema.parse(JSON.parse(text)).platform
}

export async function clearUnavailablePrivateControl(
  stateDirectory: string,
): Promise<void> {
  const filename = path.join(stateDirectory, unavailableControlName)
  if ((await readUnavailablePrivateControl(stateDirectory)) !== null)
    await fs.unlink(filename)
}

export async function storeUnavailablePrivateControl(options: {
  stateDirectory: string
  platform: Exclude<NodeJS.Platform, "darwin">
  provenance?: NativeCredentialProvenance
}): Promise<void> {
  await fs.mkdir(options.stateDirectory, { recursive: true, mode: 0o700 })
  const directory = await fs.realpath(options.stateDirectory)
  const records: Array<{
    name: "native-control-unavailable.json" | "credential-provenance.json"
    value: NativeCredentialProvenance | z.infer<typeof unavailableControlSchema>
  }> = [
    {
      name: unavailableControlName,
      value: {
        kind: "copilot-proxy-native-control-unavailable",
        protocol: PROTOCOL_VERSION,
        platform: options.platform,
      },
    },
  ]
  if (options.provenance)
    records.push({
      name: "credential-provenance.json",
      value: options.provenance,
    })
  for (const record of records) {
    const filename = path.join(directory, record.name)
    const stats = await fs.lstat(filename).catch((error: unknown) => {
      if (isMissing(error)) return null
      throw error
    })
    if (stats && !stats.isFile())
      throw new Error("Native metadata cannot replace a link or directory.")
    const temporary = `${filename}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, JSON.stringify(record.value), {
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
}
export const publisherAddressSchema = z
  .object({
    publisherId: z.string().regex(/^[a-f0-9]{32}$/),
    nonce: z.string().regex(/^[a-f0-9]{64}$/),
    socketPath: z.string().min(1).max(4096),
  })
  .strict()
type PublisherAddress = z.infer<typeof publisherAddressSchema>
const { publisherId: publisherIdSchema, nonce: nonceSchema } =
  publisherAddressSchema.shape
const requestIdSchema = z.string().min(1).max(100)

const commandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read") }).strict(),
  z.object({ kind: z.literal("connection") }).strict(),
  z.object({ kind: z.literal("invoke"), intent: nativeIntentSchema }).strict(),
  z.object({ kind: z.literal("subscribe") }).strict(),
])
type PrivateCommand = z.infer<typeof commandSchema>
const requestSchema = z
  .object({
    protocol: z.literal(PROTOCOL_VERSION),
    id: requestIdSchema,
    publisherId: publisherIdSchema,
    nonce: nonceSchema,
    command: commandSchema,
  })
  .strict()
const resultSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("snapshot"), snapshot: serviceSnapshotSchema })
    .strict(),
  z
    .object({
      kind: z.literal("connection"),
      connection: nativeConnectionSchema.nullable(),
    })
    .strict(),
  z
    .object({ kind: z.literal("control"), result: controlResultSchema })
    .strict(),
  z.object({ kind: z.literal("subscribed") }).strict(),
  z
    .object({ kind: z.literal("error"), message: z.string().max(1000) })
    .strict(),
])
type PrivateResult = z.infer<typeof resultSchema>
const responseSchema = z
  .object({
    protocol: z.literal(PROTOCOL_VERSION),
    id: requestIdSchema,
    publisherId: publisherIdSchema,
    nonce: nonceSchema,
    result: resultSchema,
  })
  .strict()
const eventSchema = z
  .object({
    protocol: z.literal(PROTOCOL_VERSION),
    publisherId: publisherIdSchema,
    nonce: nonceSchema,
    event: z.literal("snapshot"),
    snapshot: serviceSnapshotSchema,
  })
  .strict()

export function secretMatches(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function isDestroyed(socket: Socket): boolean {
  return socket.destroyed
}

function wireError(message: string, code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code })
}

function writeFrame(socket: Socket, frame: unknown): void {
  if (isDestroyed(socket)) return
  const text = JSON.stringify(frame) + "\n"
  if (
    Buffer.byteLength(text) > MAX_RESPONSE_BYTES
    || socket.writableLength > MAX_RESPONSE_BYTES * 2
  ) {
    socket.destroy(
      new Error("The private proxy channel exceeded its message limit."),
    )
    return
  }
  socket.write(text)
}

function lines(
  socket: Socket,
  maximumBytes: number,
  consume: (value: unknown) => void,
): void {
  let buffered = Buffer.alloc(0)
  socket.on("data", (chunk: Buffer) => {
    if (isDestroyed(socket)) return
    buffered = Buffer.concat([buffered, chunk])
    let boundary = buffered.indexOf(10)
    while (boundary !== -1) {
      if (isDestroyed(socket)) break
      if (boundary > maximumBytes) {
        socket.destroy()
        return
      }
      const line = buffered.subarray(0, boundary)
      buffered = buffered.subarray(boundary + 1)
      try {
        consume(JSON.parse(line.toString("utf8")))
      } catch {
        socket.destroy()
        return
      }
      if (isDestroyed(socket)) return
      boundary = buffered.indexOf(10)
    }
    if (!isDestroyed(socket) && buffered.byteLength > maximumBytes)
      socket.destroy()
  })
}

async function request(
  record: PublisherAddress,
  command: PrivateCommand,
): Promise<PrivateResult> {
  return new Promise((resolve, reject) => {
    const id = randomUUID()
    const socket = createConnection(record.socketPath)
    let settled = false
    let timer = setTimeout(
      () =>
        fail(
          wireError(
            "The native proxy controller did not respond.",
            "ETIMEDOUT",
          ),
        ),
      CONNECT_TIMEOUT_MS,
    )
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      reject(error)
    }
    socket.on("error", fail)
    socket.on("close", () => {
      if (!settled)
        fail(wireError("The native proxy channel closed.", "ECONNRESET"))
    })
    socket.once("connect", () => {
      if (settled || socket.destroyed) return
      clearTimeout(timer)
      const responseTimeout =
        command.kind === "invoke" ? INVOKE_TIMEOUT_MS : READ_TIMEOUT_MS
      timer = setTimeout(
        () =>
          fail(
            wireError(
              "The native proxy controller did not respond.",
              "ETIMEDOUT",
            ),
          ),
        responseTimeout,
      )
      const frame = {
        protocol: PROTOCOL_VERSION,
        id,
        publisherId: record.publisherId,
        nonce: record.nonce,
        command,
      }
      if (Buffer.byteLength(JSON.stringify(frame)) > MAX_REQUEST_BYTES) {
        fail(new Error("The private proxy command is too large."))
        return
      }
      writeFrame(socket, frame)
    })
    lines(socket, MAX_RESPONSE_BYTES, (value) => {
      const response = responseSchema.parse(value)
      if (
        response.id !== id
        || response.publisherId !== record.publisherId
        || !secretMatches(response.nonce, record.nonce)
      ) {
        fail(new Error("The native proxy identity could not be verified."))
        return
      }
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.end()
      resolve(response.result)
    })
  })
}

export function connectProxyClient(record: PublisherAddress): ManagedSession {
  const listeners = new Set<(snapshot: ServiceSnapshot) => void>()
  let subscription: Socket | null = null
  let released = false
  const call = async (command: PrivateCommand) => {
    if (released) throw new Error("This proxy session was released.")
    const result = await request(record, command)
    if (result.kind === "error") throw new Error(result.message)
    return result
  }
  const subscribe = (listener: (snapshot: ServiceSnapshot) => void) => {
    if (released) return () => {}
    listeners.add(listener)
    if (!subscription) {
      const socket = createConnection(record.socketPath)
      subscription = socket
      socket.on("error", () => {
        socket.destroy()
      })
      socket.on("close", () => {
        if (subscription === socket) subscription = null
      })
      socket.once("connect", () =>
        writeFrame(socket, {
          protocol: PROTOCOL_VERSION,
          id: randomUUID(),
          publisherId: record.publisherId,
          nonce: record.nonce,
          command: { kind: "subscribe" },
        }),
      )
      lines(socket, MAX_RESPONSE_BYTES, (value) => {
        const event = eventSchema.safeParse(value)
        if (!event.success) {
          const acknowledgement = responseSchema.parse(value)
          if (
            acknowledgement.publisherId !== record.publisherId
            || !secretMatches(acknowledgement.nonce, record.nonce)
            || acknowledgement.result.kind !== "subscribed"
          )
            socket.destroy()
          return
        }
        if (
          event.data.publisherId !== record.publisherId
          || !secretMatches(event.data.nonce, record.nonce)
        ) {
          socket.destroy()
          return
        }
        for (const subscriber of listeners) subscriber(event.data.snapshot)
      })
    }
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        subscription?.destroy()
        subscription = null
      }
    }
  }
  return {
    kind: "managed",
    lifecycle: { kind: "observer" },
    async read() {
      const result = await call({ kind: "read" })
      if (result.kind !== "snapshot")
        throw new Error("Invalid native snapshot reply.")
      return result.snapshot
    },
    async invoke(intent) {
      const result = await call({
        kind: "invoke",
        intent: nativeIntentSchema.parse(intent),
      })
      if (result.kind !== "control")
        throw new Error("Invalid native command reply.")
      return result.result
    },
    async connection() {
      const result = await call({ kind: "connection" })
      if (result.kind !== "connection")
        throw new Error("Invalid native connection reply.")
      return result.connection
    },
    subscribe,
    release() {
      released = true
      listeners.clear()
      subscription?.destroy()
      subscription = null
      return Promise.resolve()
    },
  }
}

interface SubscribeState {
  subscribing: boolean
  emittedInitial: boolean
  hasInitialError: boolean
  initialError: unknown
}

function subscribeClient(
  socket: Socket,
  authority: HostProxySessionOptions["authority"],
  event: (snapshot: ServiceSnapshot) => void,
): (() => void) | undefined {
  const state: SubscribeState = {
    subscribing: true,
    emittedInitial: false,
    hasInitialError: false,
    initialError: undefined,
  }
  // Capture synchronous initial-snapshot throws so subscribe() still
  // returns its cleanup function and never leaks the listener.
  const forward = (snapshot: ServiceSnapshot) => {
    if (state.subscribing) {
      state.emittedInitial = true
      try {
        event(snapshot)
      } catch (error) {
        state.hasInitialError = true
        state.initialError = error
      }
      return
    }
    event(snapshot)
  }
  const release = authority.subscribe(forward)
  state.subscribing = false
  if (state.hasInitialError) {
    release()
    throw state.initialError
  }
  if (isDestroyed(socket)) {
    release()
    return undefined
  }
  if (!state.emittedInitial) {
    try {
      event(authority.snapshot())
    } catch (error) {
      release()
      throw error
    }
  }
  return release
}

export function acceptProxyClient(
  socket: Socket,
  record: PublisherAddress,
  options: HostProxySessionOptions,
): void {
  let authorized = false
  let unsubscribe: (() => void) | undefined
  let queued = 0
  let pending = Promise.resolve()
  const timeout = setTimeout(() => {
    if (!authorized) socket.destroy()
  }, CONNECT_TIMEOUT_MS)
  socket.on("error", () => socket.destroy())
  socket.on("close", () => {
    clearTimeout(timeout)
    unsubscribe?.()
    unsubscribe = undefined
  })
  const identity = {
    protocol: PROTOCOL_VERSION,
    publisherId: record.publisherId,
    nonce: record.nonce,
  }
  const response = (id: string, result: PrivateResult) =>
    writeFrame(socket, { ...identity, id, result })
  const event = (snapshot: ServiceSnapshot) =>
    writeFrame(socket, {
      ...identity,
      event: "snapshot",
      snapshot: serviceSnapshotSchema.parse(snapshot),
    })
  lines(socket, MAX_REQUEST_BYTES, (value) => {
    const frame = requestSchema.parse(value)
    if (
      frame.publisherId !== record.publisherId
      || !secretMatches(frame.nonce, record.nonce)
      || ++queued > 8
    ) {
      socket.destroy()
      return
    }
    authorized = true
    clearTimeout(timeout)
    pending = pending
      .then(async () => {
        if (socket.destroyed) return
        switch (frame.command.kind) {
          case "read": {
            response(frame.id, {
              kind: "snapshot",
              snapshot: serviceSnapshotSchema.parse(
                options.authority.snapshot(),
              ),
            })
            break
          }
          case "connection": {
            response(frame.id, {
              kind: "connection",
              connection: nativeConnectionSchema
                .nullable()
                .parse(options.authority.connection()),
            })
            break
          }
          case "invoke": {
            const result = controlResultSchema.parse(
              await options.authority.dispatch(frame.command.intent),
            )
            response(frame.id, { kind: "control", result })
            break
          }
          case "subscribe": {
            unsubscribe?.()
            unsubscribe = undefined
            response(frame.id, { kind: "subscribed" })
            unsubscribe = subscribeClient(socket, options.authority, event)
            break
          }
          default: {
            const exhaustive: never = frame.command
            throw new Error(String(exhaustive))
          }
        }
      })
      .catch(() => {
        if (socket.destroyed) return
        response(frame.id, {
          kind: "error",
          message: "The native proxy command could not be applied.",
        })
      })
      .finally(() => {
        queued--
      })
  })
}
