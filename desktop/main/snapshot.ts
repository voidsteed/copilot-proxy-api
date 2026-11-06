import type {
  NativeSnapshot,
  ServiceSnapshot,
} from "../../src/lib/proxy-contracts"
import type { ActivityRecord, DesktopSnapshot } from "../shared/contracts"
import type { ControllerContext } from "./controller-session"

import { managedCapabilitiesSchema } from "../../src/lib/proxy-contracts"

export function appendActivity(
  snapshot: Pick<DesktopSnapshot, "activity" | "totals">,
  record: ActivityRecord,
): Pick<DesktopSnapshot, "activity" | "totals"> {
  return {
    activity: [record, ...snapshot.activity].slice(0, 200),
    totals: {
      requests:
        snapshot.totals.requests === null ? null : snapshot.totals.requests + 1,
      errors:
        snapshot.totals.errors === null ?
          null
        : snapshot.totals.errors + (record.outcome === "failed" ? 1 : 0),
      inputTokens:
        snapshot.totals.inputTokens === null ?
          null
        : snapshot.totals.inputTokens + (record.inputTokens ?? 0),
      outputTokens:
        snapshot.totals.outputTokens === null ?
          null
        : snapshot.totals.outputTokens + (record.outputTokens ?? 0),
      cachedTokens:
        snapshot.totals.cachedTokens === null ?
          null
        : snapshot.totals.cachedTokens + (record.cachedTokens ?? 0),
    },
  }
}

export function initialSnapshot(
  options: Pick<
    DesktopSnapshot,
    "version" | "platform" | "fixture" | "storageMode" | "settings"
  > & {
    recovered: boolean
  },
): DesktopSnapshot {
  return {
    revision: 0,
    version: options.version,
    platform: options.platform,
    fixture: options.fixture,
    storageMode: options.storageMode,
    account: { kind: "signed-out" },
    authorization: { kind: "idle" },
    gateway: { kind: "stopped" },
    connection: null,
    source: { kind: "none" },
    runtime: null,
    settings: options.settings,
    agentConfigs: [],
    lastConfigureResult: null,
    models: [],
    modelsFetchedAt: null,
    usage: null,
    activity: [],
    totals: {
      requests: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
    },
    probe: { kind: "idle" },
    notice:
      options.recovered ?
        {
          kind: "error",
          message:
            "Saved settings could not be read. Default settings are active.",
        }
      : null,
  }
}

const capabilities = managedCapabilitiesSchema.parse({
  kind: "managed",
  runtime: "managed",
  account: "managed",
  activity: "completed",
  drain: true,
})
export function createNativeSource(
  context: ControllerContext,
): Extract<DesktopSnapshot["source"], { kind: "native-managed" }> {
  return {
    kind: "native-managed",
    sessionId: context.sessionId,
    gatewayGeneration: context.session.gatewayGeneration,
    capabilities,
  }
}
function nativeGateway(context: ControllerContext): NativeSnapshot["gateway"] {
  const gateway = context.state.gateway
  if (gateway.kind !== "running") return gateway
  return context.state.connection ?
      {
        kind: "running",
        connection: context.state.connection,
        startedAt: gateway.startedAt,
      }
    : { kind: "stopped" }
}
export function createNativeSnapshot(
  context: ControllerContext,
): NativeSnapshot {
  const account: NativeSnapshot["account"] =
    context.state.account.kind === "signed-in" ?
      {
        kind: "signed-in",
        login: context.state.account.login,
        name: context.state.account.name,
        plan: context.state.account.plan,
        credentialSource: context.account.credentialSource,
        epoch: context.account.accountGeneration,
      }
    : { kind: "signed-out" }
  return structuredClone({
    kind: "managed",
    sessionId: context.sessionId,
    gatewayGeneration: context.session.gatewayGeneration,
    revision: context.state.revision,
    account,
    authorization: context.state.authorization,
    storageMode: context.options.vault.mode,
    gateway: nativeGateway(context),
    capabilities,
    options: context.session.owned?.runtime ?? context.session.runtime,
    authentication: {
      kind:
        context.session.owned?.connection.authentication.kind
        ?? context.session.authentication.kind,
    },
    catalog: context.state.models,
    usage: context.state.usage,
    activity: context.state.activity.filter(
      (record) => record.outcome !== "observed",
    ),
    totals: context.state.totals,
  })
}
export function createServiceSnapshot(
  context: ControllerContext,
): ServiceSnapshot {
  return context.session.legacySnapshot ?
      structuredClone(context.session.legacySnapshot)
    : createNativeSnapshot(context)
}
