import { useCallback, useEffect, useRef, useState } from "react"

import {
  snapshotSchema,
  type DesktopBridge,
  type DesktopCommand,
  type DesktopSnapshot,
} from "../shared/contracts"

declare global {
  var copilotBridge: DesktopBridge | undefined
}

type SnapshotState =
  | { kind: "loading" }
  | { kind: "unavailable"; message: string }
  | { kind: "ready"; snapshot: DesktopSnapshot }

interface RendererBridge extends DesktopBridge {
  onConnectionError(listener: (message: string) => void): () => void
}

export type RunCommand = (
  command: DesktopCommand,
  successMessage?: string,
) => Promise<boolean>

export function errorMessage(error: unknown): string {
  return error instanceof Error ?
      error.message
    : "The action could not be completed. Try again."
}

function createRendererBridge(): RendererBridge {
  const native = globalThis.copilotBridge
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
        snapshotSchema.parse(await native.invoke(command)),
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
    snapshot: () => request("/__desktop/snapshot"),
    invoke: (command) => request("/__desktop/command", command),
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
        void request("/__desktop/snapshot").then(listener).catch(reportError)
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
): Promise<DesktopSnapshot> {
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
  if (!response.ok)
    throw new Error(
      `The desktop service could not complete the request (${response.status}).`,
    )
  const value: unknown = await response.json()
  return snapshotSchema.parse(value)
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
  const activeCommands = useRef(new Set<DesktopCommand["kind"]>())
  const alive = useRef(false)

  const acceptSnapshot = useCallback((snapshot: DesktopSnapshot) => {
    if (!alive.current) return
    setConnectionError(null)
    if (
      currentSnapshot.current
      && snapshot.revision <= currentSnapshot.current.revision
    )
      return
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
    async (command, successMessage) => {
      if (activeCommands.current.has(command.kind)) return false
      activeCommands.current.add(command.kind)
      setPending(new Set(activeCommands.current))
      setActionError(null)
      setConfirmation(null)
      try {
        const snapshot = await bridge.invoke(command)
        acceptSnapshot(snapshot)
        if (snapshot.notice?.kind === "error") return false
        if (alive.current && successMessage) setConfirmation(successMessage)
        return true
      } catch (error) {
        if (alive.current) setActionError(errorMessage(error))
        return false
      } finally {
        activeCommands.current.delete(command.kind)
        if (alive.current) setPending(new Set(activeCommands.current))
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
