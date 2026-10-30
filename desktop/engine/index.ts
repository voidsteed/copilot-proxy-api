import type { ModelsResponse } from "../../src/services/copilot/get-models"

import { engineCommandSchema, type EngineEvent } from "./protocol"
import { mapUpstreamUrl, UpstreamError } from "./upstream"

let initialized = false
let stopping = false
let runtime:
  | { stop(): Promise<void>; updateModels(models: ModelsResponse): void }
  | undefined

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
  const deadline = setTimeout(() => process.exit(0), 1200)
  deadline.unref()
  await runtime?.stop()
  if (!process.connected) process.exit(0)
  send({ kind: "stopped" })
}

process.on("disconnect", () => {
  void stop()
})
process.on("SIGTERM", () => {
  void stop()
})
process.on("SIGINT", () => {
  void stop()
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
  void import("./runtime")
    .then(({ startEngine }) => startEngine(init, send))
    .then((started) => {
      runtime = started
      if (stopping) return started.stop()
    })
    .catch((error: unknown) => {
      send({ kind: "error", code: startupErrorCode(error) })
      void stop()
    })
})

if (!process.send) process.exit(1)
