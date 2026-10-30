import { fork, type ChildProcess } from "node:child_process"

import type { ModelsResponse } from "../../src/services/copilot/get-models"
import type { ActivityRecord } from "../shared/contracts"

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

  constructor(kind: ProxyProcessError["kind"]) {
    super(kind)
    this.kind = kind
  }
}

export interface ProxyProcess {
  readonly ready: Promise<void>
  updateModels(models: ModelsResponse): Promise<void>
  stop(): Promise<void>
}

function childEnvironment(): NodeJS.ProcessEnv {
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
  ]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key]
  }
  return environment
}

export function startProxyProcess(options: {
  runtimePath: string
  runtimeExecPath?: string
  init: EngineInit
  onActivity(record: ActivityRecord): void
  onExit(expected: boolean): void
}): ProxyProcess {
  const init = engineInitSchema.parse(options.init)
  const child = fork(options.runtimePath, [], {
    execPath: options.runtimeExecPath ?? process.execPath,
    execArgv: [],
    env: childEnvironment(),
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    serialization: "json",
  })
  const ready = Promise.withResolvers<undefined>()
  const exited = Promise.withResolvers<undefined>()
  void ready.promise.catch(() => undefined)
  let didExit = false
  let expectedExit = false
  let stopPromise: Promise<void> | undefined
  let stopTimer: ReturnType<typeof setTimeout> | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
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
    exited.resolve(undefined)
    options.onExit(expectedExit)
  }

  function stop(): Promise<void> {
    if (stopPromise) return stopPromise
    expectedExit = true
    ready.reject(new ProxyProcessError("stopped"))
    clearTimeout(startupTimer)
    if (didExit) return Promise.resolve()
    stopPromise = exited.promise
    if (child.connected) child.send({ kind: "stop" }, () => undefined)
    stopTimer = setTimeout(() => child.kill("SIGTERM"), 1500)
    killTimer = setTimeout(() => child.kill("SIGKILL"), 3000)
    return stopPromise
  }

  child.once("spawn", () => {
    child.send(init, (error) => {
      if (error) {
        ready.reject(new ProxyProcessError("startup"))
        void stop()
      }
    })
  })
  child.on("message", (input: unknown) =>
    handleEngineMessage(input, {
      ready: () => {
        clearTimeout(startupTimer)
        ready.resolve(undefined)
      },
      activity: (record) => options.onActivity(record),
      stopped: () => {
        if (child.connected) child.send({ kind: "exit" }, () => undefined)
      },
      catalog: (id) => catalog.acknowledge(id),
      error: (code) => ready.reject(new ProxyProcessError(code)),
      invalid: () => {
        ready.reject(new ProxyProcessError("startup"))
        void stop()
      },
    }),
  )
  child.once("error", () => {
    ready.reject(new ProxyProcessError("startup"))
    if (!child.pid) finish()
    else void stop()
  })
  child.once("exit", finish)
  return {
    ready: ready.promise,
    stop,
    updateModels: (models) => catalog.update(models),
  }
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
    activity(record: ActivityRecord): void
    stopped(): void
    catalog(id: number): void
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
