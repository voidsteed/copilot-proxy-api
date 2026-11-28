import type { LegacyProxyControl } from "../../../src/lib/legacy-proxy"
import type {
  AgentConfigView,
  AgentModel,
  AuthorizationId,
  ConfigurableAgent,
  LaunchAgentDiagnostics,
  LegacySnapshot,
  ModelSelectableAgent,
  NativeConnection,
  NativeSnapshot,
  RuntimeOverrides,
  ServiceSnapshot,
} from "../../../src/lib/proxy-contracts"
import type { ModelsResponse } from "../../../src/services/copilot/get-models"
import type {
  ActivityRecord,
  CommandOutcome,
  DesktopModel,
  DesktopSnapshot,
} from "../shared/contracts"
import type { ControllerContext } from "./controller-session"
import type { StoredCredentials } from "./types"

import {
  configuredProxyConnections,
  inspectAgentConfigs,
} from "../../../src/lib/agent-config"
import { inspectLaunchAgents } from "../../../src/lib/launch-agent-diagnostics"
import { probeLegacyProxy } from "../../../src/lib/legacy-proxy"
import {
  managedCapabilitiesSchema,
  nativeConnectionSchema,
  runtimeOptionsSchema,
} from "../../../src/lib/proxy-contracts"
import { UpstreamError } from "../engine/upstream"
import { selectLaunchModel, supportsAgent } from "../shared/connections"
import { signInError } from "./failure-messages"
import { executeProbe } from "./probe"
import {
  credentialsSchema,
  decodeRestoredAuthentication,
} from "./settings-store"

export const emptyTotals = () => ({
  requests: 0,
  errors: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
})
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
    sessionId?: string
    recovered: boolean
  },
): DesktopSnapshot {
  return {
    sessionId: options.sessionId ?? "default",
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
    launchAgentDiagnostics: [],
    lastConfigureResult: null,
    models: [],
    modelsFetchedAt: null,
    usage: null,
    activity: [],
    totals: emptyTotals(),
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
function normalizedPort(url: URL): string {
  return url.port || (url.protocol === "https:" ? "443" : "80")
}
function candidateKey(connection: NativeConnection): string {
  const url = new URL(connection.rootUrl)
  const authentication =
    connection.authentication.kind === "keyed" ?
      `keyed:${connection.authentication.key}`
    : "none"
  return `${normalizedPort(url)}:${authentication}`
}
export function applyLegacy(
  context: ControllerContext,
  snapshot: LegacySnapshot,
): void {
  context.session.legacySnapshot = snapshot
  const url = new URL(snapshot.connection.rootUrl)
  const actualPort = Number(url.port || (url.protocol === "https:" ? 443 : 80))
  const displayPort =
    Number.isInteger(actualPort) && actualPort >= 1024 && actualPort <= 65535 ?
      actualPort
    : context.state.settings.port
  context.publish({
    account: { kind: "external-unverified" },
    authorization: { kind: "idle" },
    connection: snapshot.connection,
    source: {
      kind: "legacy-cli",
      status: snapshot.status,
      observedAt: snapshot.observedAt,
      capabilities: snapshot.capabilities,
    },
    runtime: null,
    settings: { ...context.state.settings, port: displayPort },
    gateway:
      snapshot.status === "reachable" ?
        {
          kind: "running",
          url: snapshot.connection.apiUrl,
          startedAt: context.session.legacyStartedAt ?? snapshot.observedAt,
        }
      : {
          kind: "error",
          message:
            "The CLI proxy could not be reached. Start it in Terminal and refresh.",
        },
    models: snapshot.catalog,
    modelsFetchedAt:
      snapshot.status === "reachable" ?
        snapshot.observedAt
      : context.state.modelsFetchedAt,
    usage: snapshot.usage,
    activity: snapshot.activity,
    totals: snapshot.totals,
  })
}
export async function detachLegacySession(
  context: ControllerContext,
): Promise<boolean> {
  const legacy = context.session.legacy
  if (!legacy) return false
  context.session.legacyUnsubscribe?.()
  context.session.legacyUnsubscribe = undefined
  context.session.legacy = undefined
  context.session.legacySnapshot = undefined
  context.session.legacyConnection = undefined
  context.session.legacyStartedAt = undefined
  context.session.probeAbort?.abort()
  context.session.desiredGateway = false
  await legacy.release().catch(() => undefined)
  if (context.session.disposed) return true
  context.publish({
    account: { kind: "signed-out" },
    authorization: { kind: "idle" },
    source: { kind: "none" },
    gateway: { kind: "stopped" },
    connection: null,
    runtime: null,
    settings: {
      ...context.state.settings,
      port: context.session.runtime.port,
      accountType: context.session.runtime.accountType,
    },
    models: [],
    modelsFetchedAt: null,
    usage: null,
    activity: [],
    totals: emptyTotals(),
    probe: { kind: "idle" },
  })
  return true
}
function canDiscover(context: ControllerContext): boolean {
  return (
    !context.session.disposed
    && !context.session.owned
    && !context.session.legacy
    && !context.account.attempt
  )
}
function bindLegacy(
  context: ControllerContext,
  options: { legacy: LegacyProxyControl; connection: NativeConnection },
): void {
  const { legacy, connection } = options
  context.session.legacy = legacy
  context.session.legacyConnection = connection
  context.session.legacyStartedAt = new Date().toISOString()
  context.session.legacyUnsubscribe = legacy.subscribe((next) => {
    if (!context.session.disposed && context.session.legacy === legacy)
      applyLegacy(context, next)
  })
}
async function tryLegacyCandidate(
  context: ControllerContext,
  connection: NativeConnection,
): Promise<"unrecognized" | "cancelled" | "attached"> {
  const legacy = await probeLegacyProxy({
    connection,
    signal: context.session.disposeAbort.signal,
  })
  if (!legacy) return "unrecognized"
  if (!canDiscover(context)) {
    await legacy.release()
    return "cancelled"
  }
  bindLegacy(context, { legacy, connection })
  await context.inspectConfigs()
  return "attached"
}
async function legacyCandidates(
  context: ControllerContext,
  options?: { port?: number },
): Promise<Map<string, Array<NativeConnection>>> {
  const pinnedPort =
    options?.port
    ?? (context.settingsStore.preferManagedPort() ?
      context.session.runtime.port
    : undefined)
  const configured = await configuredProxyConnections(context.homeDirectory)
  if (
    pinnedPort !== undefined
    || context.options.homeDirectory !== undefined
    || context.state.settings.port !== 4141
  ) {
    const port = pinnedPort ?? context.state.settings.port
    configured.push(
      nativeConnectionSchema.parse({
        rootUrl: `http://localhost:${String(port)}/`,
        apiUrl: `http://localhost:${String(port)}/v1`,
        authentication: { kind: "none" },
      }),
    )
  }
  const endpoints = new Map<string, Array<NativeConnection>>()
  for (const connection of configured) {
    const port = normalizedPort(new URL(connection.rootUrl))
    if (pinnedPort !== undefined && port !== String(pinnedPort)) continue
    const list = endpoints.get(port)
    if (list) list.push(connection)
    else endpoints.set(port, [connection])
  }
  for (const [port, candidates] of endpoints.entries()) {
    const first = candidates.at(0)
    if (first && context.account.credentials)
      candidates.push(
        nativeConnectionSchema.parse({
          rootUrl: first.rootUrl,
          apiUrl: first.apiUrl,
          authentication: {
            kind: "keyed",
            key: context.account.credentials.gatewayKey,
          },
        }),
      )
    candidates.sort(
      (left, right) =>
        Number(left.authentication.kind === "keyed")
        - Number(right.authentication.kind === "keyed"),
    )
    const seen = new Set<string>()
    endpoints.set(
      port,
      candidates.filter((candidate) => {
        const identity = candidateKey(candidate)
        if (seen.has(identity)) return false
        seen.add(identity)
        return true
      }),
    )
  }
  return endpoints
}
export function discoverLegacy(
  context: ControllerContext,
  options?: { attempted?: Set<string>; port?: number },
): Promise<boolean> {
  if (context.session.legacy) return Promise.resolve(true)
  if (context.session.discovery) return context.session.discovery
  const task = (async () => {
    const endpoints = await legacyCandidates(context, options)
    for (const candidates of endpoints.values())
      for (const connection of candidates) {
        const key = candidateKey(connection)
        if (options?.attempted?.has(key)) continue
        if (!canDiscover(context)) return false
        options?.attempted?.add(key)
        const result = await tryLegacyCandidate(context, connection)
        if (result === "attached") return true
        if (result === "cancelled") return false
      }
    return false
  })().finally(() => {
    if (context.session.discovery === task)
      context.session.discovery = undefined
  })
  context.session.discovery = task
  return task
}
export function proposeAgentModel(
  state: Pick<DesktopSnapshot, "settings" | "models">,
  target: ModelSelectableAgent,
): Extract<AgentModel, { kind: "proposed" }> | null {
  const selected = state.settings.agentModelChoices[target]
  if (target === "antigravity") {
    const candidate = selectLaunchModel(state.models, target, selected)
    return candidate ? { kind: "proposed", catalogId: candidate.id } : null
  }
  const configured = state.models.find(
    (model) => model.id === selected && supportsAgent(model, target),
  )
  const compatible = state.models.filter((model) =>
    supportsAgent(model, target),
  )
  const candidate =
    configured
    ?? compatible.find((model) =>
      target === "claude-code" ?
        model.id.startsWith("claude")
        || model.vendor.toLowerCase().includes("anthropic")
      : model.id.startsWith("gpt"),
    )
    ?? compatible.at(0)
  return candidate ? { kind: "proposed", catalogId: candidate.id } : null
}
export async function inspectAllAgents(options: {
  homeDirectory: string
  connection: NativeConnection | null
  state: Pick<DesktopSnapshot, "settings" | "models">
}): Promise<{
  agentConfigs: Array<AgentConfigView>
  launchAgentDiagnostics: Array<LaunchAgentDiagnostics>
}> {
  const [agentConfigs, launchAgentDiagnostics] = await Promise.all([
    inspectAgentConfigs({
      homeDirectory: options.homeDirectory,
      connection: options.connection,
      catalog: options.state.models,
      proposals: {
        "claude-code":
          proposeAgentModel(options.state, "claude-code")?.catalogId ?? null,
        codex: proposeAgentModel(options.state, "codex")?.catalogId ?? null,
        opencode:
          proposeAgentModel(options.state, "opencode")?.catalogId ?? null,
        antigravity:
          proposeAgentModel(options.state, "antigravity")?.catalogId ?? null,
      },
    }),
    inspectLaunchAgents(options.homeDirectory),
  ])
  return { agentConfigs, launchAgentDiagnostics }
}
export function defaultRuntimeOptions(
  settings: Pick<DesktopSnapshot["settings"], "port" | "accountType">,
) {
  return runtimeOptionsSchema.parse({
    port: settings.port,
    accountType: settings.accountType,
    manualApprove: false,
    rateLimitSeconds: null,
    rateLimitWait: false,
    responsesContextTrim: false,
    proxyFromEnvironment: false,
  })
}
export function shouldClearConfigureResult(options: {
  prior: DesktopSnapshot["lastConfigureResult"]
  views: Array<AgentConfigView>
  clearStaleTarget?: ConfigurableAgent
}): boolean {
  const { prior, views, clearStaleTarget } = options
  if (clearStaleTarget === undefined || prior === null) return false
  if (prior.view.target !== clearStaleTarget) return false
  const latest = views.find((view) => view.target === clearStaleTarget)
  return !latest || latest.status !== prior.view.status
}
export async function runGatewayProbe(
  context: ControllerContext,
  model: DesktopModel,
  prompt: string,
): Promise<void> {
  const connection = context.activeConnection()
  if (!connection) {
    context.publish({
      probe: {
        kind: "error",
        message: "Start the gateway before sending a test request.",
      },
    })
    return
  }
  context.session.probeAbort?.abort()
  const abort = new AbortController()
  context.session.probeAbort = abort
  const revision = context.session.configurationRevision
  const current = () =>
    !context.session.disposed
    && !abort.signal.aborted
    && revision === context.session.configurationRevision
  context.publish({ probe: { kind: "running", model: model.id } })
  try {
    const result = await executeProbe({
      connection,
      model,
      prompt,
      signal: abort.signal,
    })
    if (current()) {
      context.publish({ probe: result })
      if (context.session.legacy)
        applyLegacy(context, await context.session.legacy.read())
    }
  } catch {
    if (current())
      context.publish({
        probe: {
          kind: "error",
          message:
            "The test request failed. Check gateway activity and try another model or refresh your account.",
        },
      })
  }
}
export function evaluateRefreshOutcome(
  context: ControllerContext,
  results: [
    PromiseSettledResult<{ catalogSyncFailed: boolean }>,
    PromiseSettledResult<void>,
  ],
): CommandOutcome {
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  )
  if (rejected.length > 0) {
    const unauthorized = rejected.some(
      (result) =>
        result.reason instanceof UpstreamError
        && result.reason.kind === "unauthorized",
    )
    if (unauthorized) {
      const message = signInError(new UpstreamError("unauthorized"))
      context.publish({
        account: { kind: "error", message },
        notice: { kind: "error", message },
      })
      return { kind: "rejected", message }
    }
    const message =
      "Some account data could not be refreshed. Last successful values are still shown."
    context.notice(message)
    return { kind: "rejected", message }
  }
  if (results[0].status === "fulfilled" && results[0].value.catalogSyncFailed) {
    const message =
      "Model list refreshed, but the running gateway could not update its catalog yet. Restart the gateway if new models are missing."
    context.notice(message, "info")
    return { kind: "ok", message }
  }
  return { kind: "ok" }
}
export type AuthorizationAttempt = {
  id: AuthorizationId
  abort: AbortController
}
export interface ControllerAccountState {
  catalog: ModelsResponse | undefined
  credentials: StoredCredentials | null
  savedCredentials: StoredCredentials | null
  credentialSource: "native-vault" | "session-override"
  accountGeneration: number
  attempt: AuthorizationAttempt | undefined
  refreshAbort: AbortController | undefined
  storage: Promise<void>
  restoring: Promise<void> | undefined
}
export function createControllerAccountState(): ControllerAccountState {
  return {
    catalog: undefined,
    credentials: null,
    savedCredentials: null,
    credentialSource: "native-vault",
    accountGeneration: 0,
    attempt: undefined,
    refreshAbort: undefined,
    storage: Promise.resolve(),
    restoring: undefined,
  }
}
export function writeCredentials<T>(
  context: ControllerContext,
  task: () => Promise<T>,
): Promise<T> {
  const next = context.account.storage.then(task)
  context.account.storage = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}
export function isAccountCurrent(
  context: ControllerContext,
  generation: number,
  signal?: AbortSignal,
): boolean {
  return (
    !context.session.disposed
    && !signal?.aborted
    && generation === context.account.accountGeneration
  )
}
export function isAuthorizationCurrent(
  context: ControllerContext,
  attempt: AuthorizationAttempt,
): boolean {
  return (
    !context.session.disposed
    && context.account.attempt === attempt
    && !attempt.abort.signal.aborted
  )
}
export function clearAttempt(
  context: ControllerContext,
  attempt: AuthorizationAttempt,
): void {
  if (context.account.attempt === attempt) context.account.attempt = undefined
}
export function restoreSavedState(
  context: ControllerContext,
  credentials: StoredCredentials | null,
  authentication: NonNullable<RuntimeOverrides["authentication"]>,
): void {
  context.account.credentials = credentials
  context.account.savedCredentials = credentials
  context.session.authentication = authentication
}
export async function loadSavedCredentials(
  context: ControllerContext,
): Promise<void> {
  try {
    const loaded = await context.options.vault.load()
    const credentials = loaded ? credentialsSchema.parse(loaded) : null
    const authentication = await decodeRestoredAuthentication({
      vault: context.options.vault,
      stored: context.settingsStore.runtime(),
      gatewayKey: credentials?.gatewayKey ?? null,
    })
    restoreSavedState(context, credentials, authentication)
  } catch {
    context.notice(
      "Saved sign-in or proxy settings could not be restored. Sign in again.",
    )
  }
}
export async function restoreSavedAccount(
  context: ControllerContext,
): Promise<void> {
  await (context.account.savedCredentials ?
    context.options.vault.save(context.account.savedCredentials)
  : context.options.vault.clear())
}
