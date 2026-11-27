import path from "node:path"

import type {
  CreatorLease,
  LegacySession,
  LegacySnapshot,
  ManagedSession,
  OpenProxySessionOptions,
  ProxySession,
} from "./proxy-contracts"

import { legacyIntentCompatible } from "./legacy-proxy"
import { isMissing, optionalJson, privateDirectory } from "./proxy-session-wire"

export async function canFallBackToStandalone(options: {
  stateDirectory: string
  intent: OpenProxySessionOptions["intent"]
  session: ManagedSession
}): Promise<boolean> {
  if (options.intent.credential.kind !== "native-saved-account") return false
  const directory = await privateDirectory(options.stateDirectory).catch(
    (error: unknown) => {
      if (isMissing(error)) return null
      throw error
    },
  )
  if (!directory) return false
  const provenance = await optionalJson(
    path.join(directory, "credential-provenance.json"),
  )
  if (provenance !== undefined) return false
  const snapshot = await options.session.read()
  return (
    snapshot.kind === "managed"
    && snapshot.account.kind === "signed-out"
    && snapshot.gateway.kind === "stopped"
  )
}

export async function resolveDirectLegacySession(
  session: LegacySession,
  intent: OpenProxySessionOptions["intent"],
): Promise<ProxySession> {
  const snapshot = await session.read()
  if (await legacyIntentCompatible(intent, snapshot)) return session
  await session.release()
  return {
    kind: "unavailable",
    message:
      snapshot.status === "unreachable" ?
        "The existing CLI proxy is no longer reachable."
      : "The existing CLI is read-only. Stop it normally before changing its account or runtime through Copilot Proxy.",
  }
}

export async function resolveBrokerLegacySnapshot(options: {
  session: ManagedSession
  intent: OpenProxySessionOptions["intent"]
  snapshot: LegacySnapshot
}): Promise<ProxySession> {
  let legacySnapshot = options.snapshot
  if (legacySnapshot.status === "reachable") {
    const refreshed = await options.session.invoke({ kind: "refresh" })
    if (
      refreshed.kind === "session-changed"
      && refreshed.snapshot.kind === "legacy"
    )
      legacySnapshot = refreshed.snapshot
  }
  if (await legacyIntentCompatible(options.intent, legacySnapshot))
    return options.session
  await options.session.release()
  return {
    kind: "unavailable",
    message:
      legacySnapshot.status === "unreachable" ?
        "The existing CLI proxy is no longer reachable. Detach it in Copilot Proxy or run without --shared."
      : "The existing CLI is read-only. Stop it normally before changing its account or runtime through Copilot Proxy.",
  }
}

export function attachCreatorLifecycle(
  session: ManagedSession,
  lease: CreatorLease,
): ManagedSession {
  return {
    ...session,
    lifecycle: {
      kind: "creator",
      lease,
      stopCreatedGateway: () =>
        session.invoke({
          kind: "stop-gateway",
          expected: lease,
          timeoutMs: 15_000,
        }),
    },
  }
}
