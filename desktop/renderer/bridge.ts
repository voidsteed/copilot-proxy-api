import { useCallback, useEffect, useRef, useState } from "react"
import { ZodError } from "zod"

import {
  commandResponseSchema,
  snapshotSchema,
  type CommandResponse,
  type DesktopBridge,
  type DesktopCommand,
  type DesktopSnapshot,
} from "../shared/contracts"

declare global {
  var copilotProxy: DesktopBridge | undefined
}

type SnapshotState =
  | { kind: "loading" }
  | { kind: "unavailable"; message: string }
  | { kind: "ready"; snapshot: DesktopSnapshot }

interface RendererBridge {
  snapshot(): Promise<DesktopSnapshot>
  invoke(command: DesktopCommand): Promise<CommandResponse>
  subscribe(listener: (snapshot: DesktopSnapshot) => void): () => void
  onConnectionError(listener: (message: string) => void): () => void
}

export interface RunCommandOptions {
  silent?: boolean
}

export type RunCommand = (
  command: DesktopCommand,
  successMessage?: string,
  options?: RunCommandOptions,
) => Promise<boolean>

export function errorMessage(error: unknown): string {
  if (error instanceof ZodError) {
    const path = error.issues[0]?.path.join(".")
    return path ?
        `The desktop service returned an unexpected response (${path}).`
      : "The desktop service returned an unexpected response."
  }
  if (error instanceof Error) {
    const cleaned = error.message
      .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/u, "")
      .trim()
    return cleaned || "The action could not be completed. Try again."
  }
  return "The action could not be completed. Try again."
}

export function shouldAcceptSnapshot(
  current: Pick<DesktopSnapshot, "sessionId" | "revision"> | null,
  incoming: Pick<DesktopSnapshot, "sessionId" | "revision">,
): boolean {
  return (
    current === null
    || incoming.sessionId !== current.sessionId
    || incoming.revision > current.revision
  )
}

export function commandKey(command: DesktopCommand): string {
  if ("target" in command) {
    if ("modelId" in command && "shell" in command)
      return `${command.kind}:${command.target}:${command.modelId}:${command.shell}`
    if ("modelId" in command)
      return `${command.kind}:${command.target}:${command.modelId}`
    return `${command.kind}:${command.target}`
  }
  if (command.kind === "select-model")
    return `${command.kind}:${command.modelId}`
  return command.kind
}

function commandFeedback(
  response: CommandResponse,
  successMessage?: string,
): { ok: boolean; error: string | null; toast: string | null } {
  if (response.outcome.kind === "rejected") {
    const duplicate =
      response.snapshot.notice?.kind === "error"
      && response.snapshot.notice.message === response.outcome.message
    return {
      ok: false,
      error: duplicate ? null : response.outcome.message,
      toast: null,
    }
  }
  const toast = response.outcome.message ?? successMessage ?? null
  const duplicate =
    toast !== null
    && response.snapshot.notice?.kind === "info"
    && response.snapshot.notice.message === toast
  return { ok: true, error: null, toast: duplicate ? null : toast }
}

function createRendererBridge(): RendererBridge {
  const native = globalThis.copilotProxy
  const errorListeners = new Set<(message: string) => void>()
  const reportError = (error: unknown) => {
    const message = errorMessage(error)
    for (const listener of errorListeners) listener(message)
  }
  const onConnectionError = (listener: (message: string) => void) => {
    errorListeners.add(listener)
    return () => {
      errorListeners.delete(listener)
    }
  }

  if (native) {
    return {
      snapshot: async () => snapshotSchema.parse(await native.snapshot()),
      invoke: async (command) =>
        commandResponseSchema.parse(await native.invoke(command)),
      subscribe: (listener) =>
        native.subscribe((value) => {
          try {
            listener(snapshotSchema.parse(value))
          } catch (error) {
            reportError(error)
          }
        }),
      onConnectionError,
    }
  }

  return {
    snapshot: async () =>
      snapshotSchema.parse(await request("/__desktop/snapshot")),
    invoke: async (command) =>
      commandResponseSchema.parse(await request("/__desktop/command", command)),
    subscribe: (listener) => {
      const source = new EventSource("/__desktop/events")
      const onSnapshot = (data: string) => {
        try {
          const value: unknown = JSON.parse(data)
          listener(snapshotSchema.parse(value))
        } catch (error) {
          reportError(error)
        }
      }
      source.addEventListener("snapshot", (event) => {
        if (event instanceof MessageEvent && typeof event.data === "string") {
          onSnapshot(event.data)
        } else {
          reportError(new Error("The desktop service sent an invalid update."))
        }
      })
      source.addEventListener("open", () => {
        void request("/__desktop/snapshot")
          .then((value) => snapshotSchema.parse(value))
          .then(listener)
          .catch(reportError)
      })
      source.addEventListener("error", () =>
        reportError(
          new Error("The desktop connection was interrupted. Reconnecting…"),
        ),
      )
      return () => {
        source.close()
      }
    },
    onConnectionError,
  }
}

async function request(
  path: string,
  command?: DesktopCommand,
): Promise<unknown> {
  const response = await fetch(
    path,
    command ?
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      }
    : { cache: "no-store" },
  )
  if (!response.ok) {
    let detail: string | null = null
    try {
      const body: unknown = await response.json()
      if (
        typeof body === "object"
        && body !== null
        && "error" in body
        && typeof body.error === "string"
        && body.error.trim().length > 0
      ) {
        detail = body.error.trim()
      }
    } catch {
      detail = null
    }
    throw new Error(
      detail
        ?? `The desktop service could not complete the request (${response.status}).`,
    )
  }
  return response.json()
}

export function useDesktop() {
  const [bridge] = useState(createRendererBridge)
  const [state, setState] = useState<SnapshotState>({ kind: "loading" })
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<string | null>(null)
  const [pending, setPending] = useState<ReadonlySet<DesktopCommand["kind"]>>(
    new Set(),
  )
  const currentSnapshot = useRef<DesktopSnapshot | null>(null)
  const activeCommands = useRef(new Map<string, DesktopCommand["kind"]>())
  const alive = useRef(false)

  const acceptSnapshot = useCallback((snapshot: DesktopSnapshot) => {
    if (!alive.current) return
    if (!shouldAcceptSnapshot(currentSnapshot.current, snapshot)) return
    setConnectionError(null)
    currentSnapshot.current = snapshot
    setState({ kind: "ready", snapshot })
  }, [])

  const refreshSnapshot = useCallback(async () => {
    try {
      acceptSnapshot(await bridge.snapshot())
    } catch (error) {
      if (!alive.current) return
      const message = errorMessage(error)
      if (currentSnapshot.current) setConnectionError(message)
      else setState({ kind: "unavailable", message })
    }
  }, [acceptSnapshot, bridge])

  useEffect(() => {
    alive.current = true
    const unsubscribeErrors = bridge.onConnectionError((message) => {
      if (alive.current) setConnectionError(message)
    })
    const unsubscribe = bridge.subscribe(acceptSnapshot)
    void refreshSnapshot()
    return () => {
      alive.current = false
      unsubscribe()
      unsubscribeErrors()
    }
  }, [acceptSnapshot, bridge, refreshSnapshot])

  useEffect(() => {
    if (!confirmation) return
    const timer = globalThis.setTimeout(() => {
      setConfirmation(null)
    }, 4200)
    return () => {
      globalThis.clearTimeout(timer)
    }
  }, [confirmation])

  const run: RunCommand = useCallback(
    async (command, successMessage, options) => {
      const key = commandKey(command)
      if (activeCommands.current.has(key)) return false
      activeCommands.current.set(key, command.kind)
      setPending(new Set(activeCommands.current.values()))
      const silent = options?.silent === true
      if (!silent) {
        setActionError(null)
        setConfirmation(null)
      }
      try {
        const response = await bridge.invoke(command)
        acceptSnapshot(response.snapshot)
        const feedback = commandFeedback(response, successMessage)
        if (alive.current && feedback.error) setActionError(feedback.error)
        if (alive.current && !silent && feedback.toast)
          setConfirmation(feedback.toast)
        return feedback.ok
      } catch (error) {
        if (alive.current) setActionError(errorMessage(error))
        return false
      } finally {
        activeCommands.current.delete(key)
        if (alive.current) setPending(new Set(activeCommands.current.values()))
      }
    },
    [acceptSnapshot, bridge],
  )

  return {
    state,
    pending,
    run,
    connectionError,
    actionError,
    confirmation,
    refreshSnapshot,
    dismissError: () => {
      setActionError(null)
    },
  }
}
