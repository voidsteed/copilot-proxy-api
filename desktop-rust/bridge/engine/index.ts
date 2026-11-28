import type { ModelsResponse } from "../../../src/services/copilot/get-models"
import type { DrainResult } from "./runtime"

import {
  engineCommandSchema,
  type EngineEvent,
  type EngineInit,
} from "./protocol"
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
let runtimeStop: Promise<void> | undefined
let initialization: Promise<void> | undefined
let signalShutdown: Promise<never> | undefined
let fatalShutdown: Promise<never> | undefined

function send(event: EngineEvent): void {
  if (process.connected) process.send?.(event, () => undefined)
}

function sendAndFlush(event: EngineEvent): Promise<void> {
  if (!process.connected || !process.send) return Promise.resolve()
  return new Promise((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(done, 250)
    timer.unref()
    try {
      process.send?.(event, done)
    } catch {
      done()
    }
  })
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

function stopRuntimeOnce(): Promise<void> {
  if (!runtime) return Promise.resolve()
  const current = runtime
  runtimeStop ??= current.stop().then(
    () => undefined,
    () => undefined,
  )
  return runtimeStop
}

async function boundedRuntimeStop(timeoutMs = 1500): Promise<void> {
  const task = stopRuntimeOnce()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      task,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
        timer.unref()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function stop(): Promise<void> {
  if (stopping) return
  stopping = true
  await initialization
  await stopRuntimeOnce()
  if (!process.connected) process.exit(0)
  send({ kind: "stopped" })
}

function terminateOnSignal(exitCode: number): void {
  stopping = true
  signalShutdown ??= (async () => {
    await boundedRuntimeStop(1500)
    process.exit(exitCode)
  })()
}

function fatalExit(
  reason: Extract<EngineEvent, { kind: "fatal" }>["reason"],
  code: Extract<EngineEvent, { kind: "fatal" }>["code"],
): void {
  stopping = true
  fatalShutdown ??= (async () => {
    await sendAndFlush({ kind: "fatal", reason, code })
    await boundedRuntimeStop(1500)
    process.exit(1)
  })()
}

function rejectCommand(id: number): void {
  send({
    kind: "command-rejected",
    id,
    reason: stopping ? "stopping" : "not-ready",
  })
}

function startInitialization(init: EngineInit): void {
  if (initialized || stopping) return
  initialized = true
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
    .then(({ startEngine }) =>
      startEngine(init, send, () =>
        fatalExit("auth-revoked", "authentication"),
      ),
    )
    .then((started) => {
      if (stopping) {
        void started.stop().catch(() => undefined)
        return
      }
      runtime = started
    })
    .catch((error: unknown) => {
      if (stopping) return
      stopping = true
      send({ kind: "error", code: startupErrorCode(error) })
      send({ kind: "stopped" })
      if (!process.connected) process.exit(1)
    })
}

process.on("disconnect", () => {
  terminateOnSignal(0)
})
process.on("SIGTERM", () => {
  terminateOnSignal(1)
})
process.on("SIGINT", () => {
  terminateOnSignal(1)
})
process.on("uncaughtException", () => {
  fatalExit("crashed", "runtime")
})
process.on("unhandledRejection", () => {
  fatalExit("crashed", "runtime")
})

process.on("message", (input: unknown) => {
  const parsed = engineCommandSchema.safeParse(input)
  if (!parsed.success) {
    fatalExit("crashed", "runtime")
    return
  }
  const command = parsed.data
  switch (command.kind) {
    case "exit": {
      if (stopping) process.exit(0)
      else void stop()
      return
    }
    case "stop": {
      void stop()
      return
    }
    case "drain": {
      if (!runtime || stopping) {
        rejectCommand(command.id)
        return
      }
      void runtime.drain(command.timeoutMs).then((result) => {
        send(
          result.kind === "drained" ?
            { kind: "drained", id: command.id, inFlight: 0 }
          : {
              kind: "drain-timeout",
              id: command.id,
              inFlight: result.inFlight,
            },
        )
      })
      return
    }
    case "resume": {
      if (!runtime || stopping) {
        rejectCommand(command.id)
        return
      }
      runtime.resume()
      send({ kind: "resumed", id: command.id })
      return
    }
    case "catalog": {
      if (!runtime || stopping) {
        rejectCommand(command.id)
        return
      }
      runtime.updateModels(command.models)
      send({ kind: "catalog-updated", id: command.id })
      return
    }
    case "init": {
      startInitialization(command)
      return
    }
    default: {
      const exhaustive: never = command
      return exhaustive
    }
  }
})

if (!process.send) process.exit(1)
