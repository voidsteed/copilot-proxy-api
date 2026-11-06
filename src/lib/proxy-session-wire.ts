import { randomUUID, timingSafeEqual } from "node:crypto"
import fs from "node:fs/promises"
import { createConnection, type Socket } from "node:net"
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

function missingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

export async function readUnavailablePrivateControl(
  stateDirectory: string,
): Promise<Exclude<NodeJS.Platform, "darwin"> | null> {
  const filename = path.join(stateDirectory, unavailableControlName)
  const stats = await fs.lstat(filename).catch((error: unknown) => {
    if (missingFile(error)) return null
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
      if (missingFile(error)) return null
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
        if (!missingFile(error)) throw error
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

function writeFrame(socket: Socket, frame: unknown): void {
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
    buffered = Buffer.concat([buffered, chunk])
    let boundary = buffered.indexOf(10)
    while (boundary !== -1) {
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
      boundary = buffered.indexOf(10)
    }
    if (buffered.byteLength > maximumBytes) socket.destroy()
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
    const timeout = command.kind === "invoke" ? 65_000 : CONNECT_TIMEOUT_MS
    const timer = setTimeout(
      () => fail(new Error("The native proxy controller did not respond.")),
      timeout,
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
      if (!settled) fail(new Error("The native proxy channel closed."))
    })
    socket.once("connect", () => {
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
  socket.on("error", () => {
    socket.destroy()
  })
  socket.on("close", () => {
    clearTimeout(timeout)
    unsubscribe?.()
  })
  const response = (id: string, result: PrivateResult) =>
    writeFrame(socket, {
      protocol: PROTOCOL_VERSION,
      id,
      publisherId: record.publisherId,
      nonce: record.nonce,
      result,
    })
  const event = (snapshot: ServiceSnapshot) =>
    writeFrame(socket, {
      protocol: PROTOCOL_VERSION,
      publisherId: record.publisherId,
      nonce: record.nonce,
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
            response(frame.id, { kind: "subscribed" })
            unsubscribe = options.authority.subscribe(event)
            event(options.authority.snapshot())
            break
          }
          default: {
            const exhaustive: never = frame.command
            throw new Error(String(exhaustive))
          }
        }
      })
      .catch(() => {
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
