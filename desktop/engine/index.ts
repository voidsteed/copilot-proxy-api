import type { ModelsResponse } from "../../src/services/copilot/get-models"
import type { DrainResult } from "./runtime"

import { engineCommandSchema, type EngineEvent } from "./protocol"
import { mapUpstreamUrl, UpstreamError } from "./upstream"

let initialized = false
let stopping = false
let runtime:
  | {
      stop(): Promise<DrainResult>
      drain(timeoutMs: number): Promise<DrainResult>
      resume(): void
      updateModels(models: ModelsResponse): void
    }
  | undefined
let initialization: Promise<void> | undefined
let orphanedStop: Promise<void> | undefined

function send(event: EngineEvent): void {
  if (process.connected) process.send?.(event, () => undefined)
}

function startupErrorCode(
  error: unknown,
): Extract<EngineEvent, { kind: "error" }>["code"] {
  if (error instanceof Error && "code" in error && error.code === "EADDRINUSE")
    return "address-in-use"
  if (error instanceof UpstreamError)
    return error.kind === "unauthorized" ? "authentication" : "upstream"
  return "startup"
}

async function stop(): Promise<void> {
  if (stopping) return
  stopping = true
  await initialization
  await runtime?.stop()
  if (!process.connected) process.exit(0)
  send({ kind: "stopped" })
}

function stopOrphan(): void {
  orphanedStop ??= (async () => {
    await stop()
    process.exit(0)
  })()
}

process.on("disconnect", () => {
  stopOrphan()
})
process.on("SIGTERM", () => {
  stopOrphan()
})
process.on("SIGINT", () => {
  stopOrphan()
})
process.on("uncaughtException", () => {
  send({ kind: "error", code: "startup" })
  void stop()
})
process.on("unhandledRejection", () => {
  send({ kind: "error", code: "startup" })
  void stop()
})

process.on("message", (input: unknown) => {
  const parsed = engineCommandSchema.safeParse(input)
  if (!parsed.success) {
    void stop()
    return
  }
  if (parsed.data.kind === "exit") {
    if (stopping) process.exit(0)
    else void stop()
    return
  }
  if (parsed.data.kind === "drain") {
    const command = parsed.data
    void runtime?.drain(command.timeoutMs).then((result) => {
      send(
        result.kind === "drained" ?
          { kind: "drained", id: command.id, inFlight: 0 }
        : { kind: "drain-timeout", id: command.id, inFlight: result.inFlight },
      )
    })
    return
  }
  if (parsed.data.kind === "resume") {
    runtime?.resume()
    send({ kind: "resumed", id: parsed.data.id })
    return
  }
  if (parsed.data.kind === "catalog") {
    if (!runtime || stopping) return
    runtime.updateModels(parsed.data.models)
    send({ kind: "catalog-updated", id: parsed.data.id })
    return
  }
  if (parsed.data.kind === "stop") {
    void stop()
    return
  }
  if (initialized || stopping) return
  initialized = true
  const init = parsed.data
  const originalFetch = globalThis.fetch
  if (init.fixtureOrigin) {
    const fixtureOrigin = init.fixtureOrigin
    globalThis.fetch = Object.assign(
      (
        input: Parameters<typeof fetch>[0],
        options?: Parameters<typeof fetch>[1],
      ) => {
        const source = input instanceof Request ? input.url : String(input)
        const destination = mapUpstreamUrl(source, fixtureOrigin)
        return originalFetch(
          input instanceof Request ?
            new Request(destination, input)
          : destination,
          options,
        )
      },
      originalFetch,
    )
  }
  initialization = import("./runtime")
    .then(({ startEngine }) => startEngine(init, send))
    .then((started) => {
      runtime = started
    })
    .catch((error: unknown) => {
      send({ kind: "error", code: startupErrorCode(error) })
      send({ kind: "stopped" })
      if (!process.connected) process.exit(0)
    })
})

if (!process.send) process.exit(1)
