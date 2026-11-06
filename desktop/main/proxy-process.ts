import { fork, type ChildProcess } from "node:child_process"

import type { CompletedActivity } from "../../src/lib/proxy-contracts"
import type { ModelsResponse } from "../../src/services/copilot/get-models"
import type { DrainResult } from "../engine/runtime"

import {
  engineEventSchema,
  engineInitSchema,
  type EngineInit,
  type EngineEvent,
} from "../engine/protocol"

export class ProxyProcessError extends Error {
  readonly kind:
    | "address-in-use"
    | "authentication"
    | "upstream"
    | "startup"
    | "stopped"
    | "drain-timeout"

  constructor(kind: ProxyProcessError["kind"]) {
    super(kind)
    this.kind = kind
  }
}

export interface ProxyProcess {
  readonly ready: Promise<void>
  updateModels(models: ModelsResponse): Promise<void>
  drain(timeoutMs: number): Promise<DrainResult>
  resume(): Promise<void>
  stop(timeoutMs?: number): Promise<void>
}

function spawnNativeEngine(options: {
  runtimePath: string
  runtimeExecPath?: string
}): ChildProcess {
  const environment: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1" }
  for (const key of [
    "PATH",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TZ",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
  ]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key]
  }
  return fork(options.runtimePath, [], {
    execPath: options.runtimeExecPath ?? process.execPath,
    execArgv: [],
    env: environment,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    serialization: "json",
  })
}

interface ProxyProcessOptions {
  runtimePath: string
  runtimeExecPath?: string
  init: EngineInit
  onActivity(record: CompletedActivity): void
  onDraining?(inFlight: number): void
  onExit(expected: boolean): void
}
export function startProxyProcess(options: ProxyProcessOptions): ProxyProcess {
  const init = engineInitSchema.parse(options.init)
  const child = spawnNativeEngine(options)
  const ready = Promise.withResolvers<undefined>()
  const exited = Promise.withResolvers<undefined>()
  void ready.promise.catch(() => undefined)
  let didExit = false
  let expectedExit = false
  let stopPromise: Promise<void> | undefined
  let stopTimer: ReturnType<typeof setTimeout> | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const controls = createControlChannel(child, () => didExit)
  const catalog = createCatalogChannel(
    child,
    ready.promise,
    () => expectedExit || didExit,
  )
  const startupTimer = setTimeout(() => {
    ready.reject(new ProxyProcessError("startup"))
    void stop()
  }, 30_000)

  function finish(): void {
    if (didExit) return
    didExit = true
    clearTimeout(startupTimer)
    clearTimeout(stopTimer)
    clearTimeout(killTimer)
    ready.reject(new ProxyProcessError(expectedExit ? "stopped" : "startup"))
    catalog.close()
    controls.close()
    exited.resolve(undefined)
    options.onExit(expectedExit)
  }

  function stop(timeoutMs = 15_000): Promise<void> {
    if (stopPromise) return stopPromise
    expectedExit = true
    ready.reject(new ProxyProcessError("stopped"))
    clearTimeout(startupTimer)
    if (didExit) return Promise.resolve()
    stopPromise = exited.promise
    if (child.connected) child.send({ kind: "stop" }, () => undefined)
    stopTimer = setTimeout(
      () => child.kill("SIGTERM"),
      Math.min(timeoutMs, 1500),
    )
    killTimer = setTimeout(
      () => child.kill("SIGKILL"),
      Math.min(timeoutMs + 1000, 3000),
    )
    return stopPromise
  }

  monitorEngineProcess(child, {
    init,
    fail: () => ready.reject(new ProxyProcessError("startup")),
    finish,
    stop: () => {
      void stop()
    },
  })
  child.on("message", (input: unknown) =>
    handleEngineMessage(input, {
      ready: () => {
        clearTimeout(startupTimer)
        ready.resolve(undefined)
      },
      activity: (record) => options.onActivity(record),
      stopped: () => {
        expectedExit = true
        if (child.connected) child.send({ kind: "exit" }, () => undefined)
      },
      catalog: (id) => catalog.acknowledge(id),
      draining: (inFlight) => options.onDraining?.(inFlight),
      control: (id, result) => controls.acknowledge(id, result),
      error: (code) => ready.reject(new ProxyProcessError(code)),
      invalid: () => {
        ready.reject(new ProxyProcessError("startup"))
        void stop()
      },
    }),
  )
  return {
    ready: ready.promise,
    stop,
    drain: async (timeoutMs) => {
      await ready.promise
      return controls.request("drain", timeoutMs)
    },
    resume: async () => {
      await ready.promise
      await controls.request("resume", 1000)
    },
    updateModels: (models) => catalog.update(models),
  }
}
function createControlChannel(child: ChildProcess, stopped: () => boolean) {
  let sequence = 0
  const pending = new Map<
    number,
    {
      resolve(result: DrainResult): void
      reject(error: Error): void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  return {
    request(kind: "drain" | "resume", timeoutMs: number): Promise<DrainResult> {
      if (stopped() || !child.connected)
        return Promise.reject(new ProxyProcessError("stopped"))
      const id = ++sequence
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new ProxyProcessError("drain-timeout"))
        }, timeoutMs + 1000)
        pending.set(id, { resolve, reject, timer })
        child.send(
          kind === "resume" ? { kind, id } : { kind, id, timeoutMs },
          (error) => {
            if (!error) return
            clearTimeout(timer)
            pending.delete(id)
            reject(new ProxyProcessError("stopped"))
          },
        )
      })
    },
    acknowledge(id: number, result: DrainResult): void {
      const request = pending.get(id)
      if (!request) return
      clearTimeout(request.timer)
      pending.delete(id)
      request.resolve(result)
    },
    close(): void {
      for (const request of pending.values()) {
        clearTimeout(request.timer)
        request.reject(new ProxyProcessError("stopped"))
      }
      pending.clear()
    },
  }
}
function monitorEngineProcess(
  child: ChildProcess,
  hooks: {
    init: EngineInit
    fail: () => void
    finish: () => void
    stop: () => void
  },
): void {
  child.once("spawn", () =>
    child.send(hooks.init, (error) => {
      if (error) {
        hooks.fail()
        hooks.stop()
      }
    }),
  )
  child.once("error", () => {
    hooks.fail()
    if (!child.pid) hooks.finish()
    else hooks.stop()
  })
  child.once("exit", hooks.finish)
}

function createCatalogChannel(
  child: ChildProcess,
  ready: Promise<void>,
  stopping: () => boolean,
) {
  let sequence = 0
  const updates = new Map<
    number,
    {
      resolve(): void
      reject(error: Error): void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  return {
    acknowledge(id: number): void {
      const update = updates.get(id)
      if (!update) return
      clearTimeout(update.timer)
      updates.delete(id)
      update.resolve()
    },
    close(): void {
      for (const update of updates.values()) {
        clearTimeout(update.timer)
        update.reject(new ProxyProcessError("stopped"))
      }
      updates.clear()
    },
    async update(models: ModelsResponse): Promise<void> {
      await ready
      if (stopping() || !child.connected) throw new ProxyProcessError("stopped")
      const id = ++sequence
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          updates.delete(id)
          reject(new ProxyProcessError("startup"))
        }, 5000)
        updates.set(id, { resolve, reject, timer })
        child.send({ kind: "catalog", id, models }, (error) => {
          if (!error) return
          clearTimeout(timer)
          updates.delete(id)
          reject(new ProxyProcessError("startup"))
        })
      })
    },
  }
}

function handleEngineMessage(
  input: unknown,
  handlers: {
    ready(): void
    activity(record: CompletedActivity): void
    stopped(): void
    catalog(id: number): void
    draining(inFlight: number): void
    control(id: number, result: DrainResult): void
    error(code: Extract<EngineEvent, { kind: "error" }>["code"]): void
    invalid(): void
  },
): void {
  const parsed = engineEventSchema.safeParse(input)
  if (!parsed.success) {
    handlers.invalid()
    return
  }
  switch (parsed.data.kind) {
    case "ready": {
      handlers.ready()
      return
    }
    case "activity": {
      handlers.activity(parsed.data.record)
      return
    }
    case "stopped": {
      handlers.stopped()
      return
    }
    case "catalog-updated": {
      handlers.catalog(parsed.data.id)
      return
    }
    case "drained": {
      handlers.control(parsed.data.id, { kind: "drained" })
      return
    }
    case "resumed": {
      handlers.control(parsed.data.id, { kind: "drained" })
      return
    }
    case "drain-timeout": {
      handlers.control(parsed.data.id, {
        kind: "timeout",
        inFlight: parsed.data.inFlight,
      })
      return
    }
    case "draining": {
      handlers.draining(parsed.data.inFlight)
      return
    }
    case "error": {
      handlers.error(parsed.data.code)
      return
    }
    default: {
      const exhaustive: never = parsed.data
      return exhaustive
    }
  }
}
