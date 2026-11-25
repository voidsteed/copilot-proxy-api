import type { LegacyProxyControl } from "../../src/lib/legacy-proxy"
import type {
  CompletedActivity,
  ConfigurableAgent,
  ControlResult,
  CreatorLease,
  LegacySnapshot,
  NativeConnection,
  NativeIntent,
  RuntimeOptions,
  RuntimeOverrides,
} from "../../src/lib/proxy-contracts"
import type { DrainResult } from "../engine/runtime"
import type { CommandOutcome, DesktopSnapshot } from "../shared/contracts"
import type { ControllerAccountState } from "./controller-account"
import type { ControllerOptions } from "./types"

import {
  gatewayGenerationSchema,
  nativeConnectionSchema,
  publicConnectionSchema,
  runtimeOptionsSchema,
  sessionIdSchema,
} from "../../src/lib/proxy-contracts"
import { gatewayError } from "./failure-messages"
import {
  type ProxyProcess,
  ProxyProcessError,
  startProxyProcess,
} from "./proxy-process"
import {
  createSettingsStore,
  encodeRuntimeSettings,
  unsupportedRuntime,
} from "./settings-store"
import {
  appendActivity,
  createServiceSnapshot,
  discoverLegacy,
} from "./snapshot"

export { unsupportedRuntime } from "./settings-store"
export { applyLegacy, detachLegacySession, discoverLegacy } from "./snapshot"
export type RefreshOptions = {
  allowLegacyDiscovery?: boolean
  refreshQuota?: boolean
}
export type ProcessExitReason = "requested" | "crashed" | "auth-revoked"
export type GatewayCreationReceipt = Extract<
  ControlResult,
  { kind: "applied" }
>["createdGateway"]
export type RuntimeApplication =
  | { kind: "applied"; createdGateway: GatewayCreationReceipt }
  | { kind: "preserved" }
export type NativeOperationResult =
  | Omit<Extract<ControlResult, { kind: "applied" }>, "snapshot">
  | Exclude<ControlResult, { kind: "applied" }>
type GatewayStartResult =
  | { kind: "retry" }
  | { kind: "settled"; createdGateway: GatewayCreationReceipt }
type GatewayReconciliation = {
  promise: Promise<void>
  claimant: symbol | null
  receipt: GatewayCreationReceipt
}
function publicConnection(connection: NativeConnection) {
  return publicConnectionSchema.parse({
    rootUrl: connection.rootUrl,
    apiUrl: connection.apiUrl,
    authentication: { kind: connection.authentication.kind },
  })
}
export type OwnedGateway = {
  process: ProxyProcess
  revision: number
  generation: ReturnType<typeof gatewayGenerationSchema.parse>
  ready: boolean
  startedAt: string
  connection: NativeConnection
  runtime: RuntimeOptions
}
export interface ControllerSessionState {
  runtime: RuntimeOptions
  authentication: NonNullable<RuntimeOverrides["authentication"]>
  gatewayGeneration: ReturnType<typeof gatewayGenerationSchema.parse>
  desiredGateway: boolean
  configurationRevision: number
  owned: OwnedGateway | undefined
  legacy: LegacyProxyControl | undefined
  legacySnapshot: LegacySnapshot | undefined
  legacyConnection: NativeConnection | undefined
  legacyUnsubscribe: (() => void) | undefined
  legacyStartedAt: string | undefined
  discovery: Promise<boolean> | undefined
  reconciliation: GatewayReconciliation | undefined
  gatewayQueue: Promise<void>
  probeAbort: AbortController | undefined
  disposeAbort: AbortController
  disposed: boolean
  settingsWrites: Promise<void>
}
export interface ControllerContext {
  options: ControllerOptions
  homeDirectory: string
  stateDirectory: string
  fixtureOrigin: string | undefined
  sessionId: ReturnType<typeof sessionIdSchema.parse>
  settingsStore: ReturnType<typeof createSettingsStore>
  state: DesktopSnapshot
  account: ControllerAccountState
  session: ControllerSessionState
  publish(patch: Partial<DesktopSnapshot>): void
  notice(message: string, kind?: "info" | "error"): void
  own(task: Promise<void>): void
  inspectConfigs(options?: {
    clearStaleTarget?: ConfigurableAgent
  }): Promise<void>
  refresh(options?: RefreshOptions): Promise<CommandOutcome>
  activeConnection(): NativeConnection | null
  nativeSource(): Extract<DesktopSnapshot["source"], { kind: "native-managed" }>
}
export function createControllerSessionState(
  runtime: RuntimeOptions,
): ControllerSessionState {
  return {
    runtime,
    authentication: { kind: "none" },
    gatewayGeneration: gatewayGenerationSchema.parse(0),
    desiredGateway: false,
    configurationRevision: 0,
    owned: undefined,
    legacy: undefined,
    legacySnapshot: undefined,
    legacyConnection: undefined,
    legacyUnsubscribe: undefined,
    legacyStartedAt: undefined,
    discovery: undefined,
    reconciliation: undefined,
    gatewayQueue: Promise.resolve(),
    probeAbort: undefined,
    disposeAbort: new AbortController(),
    disposed: false,
    settingsWrites: Promise.resolve(),
  }
}
export function isDisposed(context: ControllerContext): boolean {
  return context.session.disposed
}
function serializeGateway<T>(
  context: ControllerContext,
  operation: () => Promise<T>,
): Promise<T> {
  const task = context.session.gatewayQueue.then(operation)
  context.session.gatewayQueue = task.then(
    () => undefined,
    () => undefined,
  )
  return task
}
function publishStoppedIfIdle(context: ControllerContext): void {
  if (!context.session.owned)
    context.publish({
      gateway: { kind: "stopped" },
      connection: null,
      runtime: null,
    })
}
function clearDrainingIfStopped(context: ControllerContext): void {
  if (!context.session.owned && context.state.gateway.kind === "draining")
    publishStoppedIfIdle(context)
}
export function canRunGateway(
  context: ControllerContext,
  revision = context.session.configurationRevision,
): boolean {
  return (
    context.session.desiredGateway
    && !context.session.disposed
    && !context.session.legacy
    && context.state.account.kind === "signed-in"
    && revision === context.session.configurationRevision
  )
}
export function recordActivity(
  context: ControllerContext,
  process: ProxyProcess,
  record: CompletedActivity,
): void {
  if (
    context.session.disposed
    || context.session.legacy
    || context.session.owned?.process !== process
  )
    return
  context.publish(appendActivity(context.state, record))
}
export function processExited(
  context: ControllerContext,
  exit: {
    process: ProxyProcess
    expected: boolean
    reason?: ProcessExitReason
  },
): void {
  if (
    exit.expected
    || context.session.disposed
    || context.session.owned?.process !== exit.process
  )
    return
  context.session.owned = undefined
  context.session.desiredGateway = false
  context.session.probeAbort?.abort()
  const authRevoked = exit.reason === "auth-revoked"
  const message =
    authRevoked ?
      "GitHub authorization expired or was revoked. Sign in again to reconnect."
    : "The gateway exited unexpectedly. Start it again to reconnect."
  context.publish({
    connection: null,
    runtime: null,
    ...(authRevoked ? { account: { kind: "error", message } } : {}),
    gateway: { kind: "error", message },
    ...(context.state.probe.kind === "running" ?
      {
        probe: {
          kind: "error",
          message:
            "The gateway stopped before the test request finished. Start it again.",
        },
      }
    : {}),
  })
}
async function stopOwnedGateway(
  context: ControllerContext,
  previous: OwnedGateway | undefined,
): Promise<void> {
  if (!previous) return
  await previous.process.stop()
  if (context.session.owned === previous) context.session.owned = undefined
}
async function resumeOrCleanUpDraining(
  context: ControllerContext,
  target: OwnedGateway,
): Promise<boolean> {
  try {
    await target.process.resume()
  } catch (error) {
    if (context.session.owned !== target) {
      clearDrainingIfStopped(context)
      return true
    }
    if (error instanceof ProxyProcessError && error.kind === "stopped") {
      context.session.owned = undefined
      publishStoppedIfIdle(context)
      return true
    }
    await stopOwnedGateway(context, target)
    publishStoppedIfIdle(context)
    return true
  }
  if (context.session.owned !== target) {
    clearDrainingIfStopped(context)
    return true
  }
  context.publish({
    gateway: {
      kind: "running",
      url: target.connection.apiUrl,
      startedAt: target.startedAt,
    },
    connection: publicConnection(target.connection),
    runtime: target.runtime,
  })
  return false
}
type DrainAttempt =
  | { kind: "result"; result: DrainResult }
  | { kind: "stopped" }
  | { kind: "failed" }
async function requestDrain(
  target: OwnedGateway,
  timeoutMs: number,
): Promise<DrainAttempt> {
  try {
    return { kind: "result", result: await target.process.drain(timeoutMs) }
  } catch (error) {
    if (error instanceof ProxyProcessError && error.kind === "stopped")
      return { kind: "stopped" }
    if (error instanceof ProxyProcessError && error.kind === "drain-timeout")
      return { kind: "result", result: { kind: "timeout", inFlight: 1 } }
    return { kind: "failed" }
  }
}
async function drainOwnedGateway(
  context: ControllerContext,
  target: OwnedGateway,
  options: { timeoutMs?: number; current?: () => boolean } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 15000
  const current = options.current ?? (() => true)
  if (context.session.owned !== target) return true
  if (!target.ready) {
    context.publish({ gateway: { kind: "stopping" } })
    await stopOwnedGateway(context, target)
    publishStoppedIfIdle(context)
    return true
  }
  context.publish({ gateway: { kind: "draining", inFlight: 0 } })
  const attempt = await requestDrain(target, timeoutMs)
  if (attempt.kind === "stopped") {
    if (context.session.owned === target) context.session.owned = undefined
    clearDrainingIfStopped(context)
    return true
  }
  if (attempt.kind === "failed") return resumeOrCleanUpDraining(context, target)
  if (context.session.owned !== target) {
    clearDrainingIfStopped(context)
    return true
  }
  if (attempt.result.kind === "timeout" || !current())
    return resumeOrCleanUpDraining(context, target)
  await stopOwnedGateway(context, target)
  publishStoppedIfIdle(context)
  return true
}
export function drainReplacement(
  context: ControllerContext,
  target?: OwnedGateway,
  options: { timeoutMs?: number; current?: () => boolean } = {},
): Promise<boolean> {
  return serializeGateway(context, () => {
    const active = target ?? context.session.owned
    if (!active || context.session.owned !== active)
      return Promise.resolve(true)
    return drainOwnedGateway(context, active, options)
  })
}
function spawnOwnedGateway(
  context: ControllerContext,
  params: {
    revision: number
    accountGeneration: number
    runtime: RuntimeOptions
    authentication: NonNullable<RuntimeOverrides["authentication"]>
    connection: NativeConnection
    githubToken: string
    gatewayKey: string
  },
): OwnedGateway {
  const process = startProxyProcess({
    runtimePath: context.options.runtimePath,
    runtimeExecPath: context.options.runtimeExecPath,
    init: {
      kind: "init",
      githubToken: params.githubToken,
      gatewayKey: params.gatewayKey,
      authentication: params.authentication,
      port: params.runtime.port,
      accountType: params.runtime.accountType,
      options: params.runtime,
      fixtureOrigin: context.fixtureOrigin,
    },
    onActivity: (record) => {
      if (params.accountGeneration === context.account.accountGeneration)
        recordActivity(context, process, record)
    },
    onDraining: (inFlight) => {
      if (
        context.session.owned?.process === process
        && context.state.gateway.kind === "draining"
      )
        context.publish({ gateway: { kind: "draining", inFlight } })
    },
    onExit: (expected, reason?: ProcessExitReason) =>
      processExited(context, { process, expected, reason }),
  })
  context.session.gatewayGeneration = gatewayGenerationSchema.parse(
    context.session.gatewayGeneration + 1,
  )
  return {
    process,
    revision: params.revision,
    generation: context.session.gatewayGeneration,
    ready: false,
    startedAt: new Date().toISOString(),
    connection: params.connection,
    runtime: params.runtime,
  }
}
async function startOwnedGateway(
  context: ControllerContext,
): Promise<GatewayStartResult> {
  const revision = context.session.configurationRevision
  const accountGeneration = context.account.accountGeneration
  const credentials = context.account.credentials
  if (!credentials) return { kind: "settled", createdGateway: null }
  const runtime = structuredClone(context.session.runtime)
  const authentication = structuredClone(context.session.authentication)
  const connection = nativeConnectionSchema.parse({
    rootUrl: `http://127.0.0.1:${String(runtime.port)}/`,
    apiUrl: `http://127.0.0.1:${String(runtime.port)}/v1`,
    authentication:
      authentication.kind === "none" ?
        authentication
      : { kind: "keyed", key: authentication.keys[0] },
  })
  context.publish({ gateway: { kind: "starting" } })
  if (!canRunGateway(context, revision)) return { kind: "retry" }
  let owned: OwnedGateway | undefined
  try {
    owned = spawnOwnedGateway(context, {
      revision,
      accountGeneration,
      runtime,
      authentication,
      connection,
      githubToken: credentials.githubToken,
      gatewayKey: credentials.gatewayKey,
    })
    context.session.owned = owned
    context.publish({ source: context.nativeSource() })
    await owned.process.ready
    if (context.session.owned !== owned) return { kind: "retry" }
    owned.ready = true
    await applyCurrentCatalog(context, owned.process, revision)
    if (context.session.owned === owned && canRunGateway(context, revision)) {
      context.publish({
        gateway: {
          kind: "running",
          url: connection.apiUrl,
          startedAt: owned.startedAt,
        },
        connection: publicConnection(connection),
        runtime,
        source: context.nativeSource(),
      })
      await context.inspectConfigs()
      if (context.session.owned !== owned || !canRunGateway(context, revision))
        return { kind: "retry" }
      return {
        kind: "settled",
        createdGateway: {
          sessionId: context.sessionId,
          gatewayGeneration: owned.generation,
        },
      }
    }
  } catch (error) {
    if (
      (owned !== undefined && context.session.owned !== owned)
      || !canRunGateway(context, revision)
    )
      return { kind: "retry" }
    context.session.desiredGateway = false
    await stopOwnedGateway(context, owned)
    context.publish({
      gateway: { kind: "error", message: gatewayError(error) },
      connection: null,
      runtime: null,
    })
    return { kind: "settled", createdGateway: null }
  }
  return { kind: "retry" }
}
function restoreOwnedRuntime(
  context: ControllerContext,
  previous: OwnedGateway,
  expectedRevision: number,
): void {
  if (
    context.session.owned !== previous
    || context.session.configurationRevision !== expectedRevision
  )
    return
  // Keep configurationRevision strictly monotonic by advancing the preserved gateway.
  previous.revision = expectedRevision
  context.session.runtime = previous.runtime
}
async function removeObsoleteGateway(
  context: ControllerContext,
  previous: OwnedGateway,
): Promise<boolean> {
  const revision = context.session.configurationRevision
  if (
    context.session.desiredGateway
    && !context.session.disposed
    && context.state.account.kind === "signed-in"
  ) {
    if (await drainOwnedGateway(context, previous)) return true
    restoreOwnedRuntime(context, previous, revision)
    context.notice(
      "The gateway is still serving an agent request. Its running configuration was preserved. Try again after the request finishes.",
    )
    return false
  }
  context.publish({ gateway: { kind: "stopping" } })
  await stopOwnedGateway(context, previous)
  publishStoppedIfIdle(context)
  return true
}
function isGatewayUnsettled(context: ControllerContext): boolean {
  if (context.session.disposed || context.session.legacy) return false
  const owned = context.session.owned
  if (owned)
    return (
      !canRunGateway(context, owned.revision)
      || (owned.ready && context.state.gateway.kind === "draining")
    )
  return canRunGateway(context) && context.account.credentials !== null
}
function settleIdleGateway(context: ControllerContext): void {
  const kind = context.state.gateway.kind
  if (
    !context.session.owned
    && (kind === "starting" || kind === "stopping" || kind === "draining")
  )
    publishStoppedIfIdle(context)
}
export async function reconcile(
  context: ControllerContext,
): Promise<GatewayCreationReceipt> {
  while (true) {
    if (context.session.legacy) return null
    const previous = context.session.owned
    if (previous && !canRunGateway(context, previous.revision)) {
      if (!(await removeObsoleteGateway(context, previous))) return null
      continue
    }
    if (
      previous?.ready
      && canRunGateway(context, previous.revision)
      && context.state.gateway.kind === "draining"
    ) {
      if (!(await resumeOrCleanUpDraining(context, previous))) return null
      continue
    }
    if (!canRunGateway(context) || !context.account.credentials) {
      settleIdleGateway(context)
      return null
    }
    if (context.session.owned) return null
    if (await discoverLegacy(context)) return null
    const result = await startOwnedGateway(context)
    if (result.kind === "settled") return result.createdGateway
  }
}
export async function applyCurrentCatalog(
  context: ControllerContext,
  process: ProxyProcess,
  revision: number,
): Promise<void> {
  let catalog = context.account.catalog
  while (catalog && canRunGateway(context, revision)) {
    await process.updateModels(catalog)
    if (catalog === context.account.catalog) return
    catalog = context.account.catalog
  }
}
export async function convergeGateway(
  context: ControllerContext,
  options: { claimCreation?: boolean } = {},
): Promise<GatewayCreationReceipt> {
  const claim = options.claimCreation ?? true
  const token = Symbol("converge")
  const existing = context.session.reconciliation
  if (existing) {
    if (claim && existing.claimant === null) existing.claimant = token
    await existing.promise
    return existing.claimant === token ? existing.receipt : null
  }
  const active: GatewayReconciliation = {
    promise: Promise.resolve(),
    claimant: claim ? token : null,
    receipt: null,
  }
  context.session.reconciliation = active
  active.promise = serializeGateway(context, async () => {
    try {
      while (true) {
        const created = await reconcile(context)
        if (created) active.receipt = created
        if (
          active.receipt
          && context.session.owned?.generation
            !== active.receipt.gatewayGeneration
        )
          active.receipt = null
        if (!isGatewayUnsettled(context)) break
      }
    } finally {
      if (context.session.reconciliation === active)
        context.session.reconciliation = undefined
    }
  })
  await active.promise
  return active.claimant === token ? active.receipt : null
}
export function setGatewayDesired(
  context: ControllerContext,
  running: boolean,
): Promise<GatewayCreationReceipt> {
  if (context.session.legacy) {
    context.notice(
      "This gateway is running in Terminal. Manage its process there.",
    )
    return Promise.resolve(null)
  }
  if (!running && context.session.desiredGateway)
    context.session.configurationRevision++
  context.session.desiredGateway = running
  if (!running) {
    context.session.probeAbort?.abort()
    if (context.state.probe.kind === "running")
      context.publish({ probe: { kind: "idle" } })
    if (!context.session.owned && !context.session.reconciliation)
      publishStoppedIfIdle(context)
  }
  return convergeGateway(context, { claimCreation: running }).then((receipt) =>
    running ? receipt : null,
  )
}
export function queueSettings<T>(
  context: ControllerContext,
  operation: () => Promise<T>,
): Promise<T> {
  const task = context.session.settingsWrites.then(operation)
  context.session.settingsWrites = task.then(
    () => undefined,
    () => undefined,
  )
  return task
}
export async function persistRuntime(
  context: ControllerContext,
  options: {
    runtime: RuntimeOptions
    authentication: NonNullable<RuntimeOverrides["authentication"]>
    settings?: ControllerContext["state"]["settings"]
  },
): Promise<void> {
  const metadata = await encodeRuntimeSettings({
    vault: context.options.vault,
    runtime: options.runtime,
    authentication: options.authentication,
  })
  const settings = options.settings ?? {
    ...context.state.settings,
    port: options.runtime.port,
    accountType: options.runtime.accountType,
  }
  await context.settingsStore.save(settings, metadata)
}
export function activateRuntime(
  context: ControllerContext,
  options: {
    runtime: RuntimeOptions
    authentication: NonNullable<RuntimeOverrides["authentication"]>
  },
): void {
  context.session.runtime = options.runtime
  context.session.authentication = options.authentication
  context.session.configurationRevision++
  context.session.probeAbort?.abort()
  if (context.state.probe.kind === "running")
    context.publish({ probe: { kind: "idle" } })
  context.publish({
    settings: {
      ...context.state.settings,
      port: options.runtime.port,
      accountType: options.runtime.accountType,
    },
  })
}
export function applyRuntime(
  context: ControllerContext,
  explicit: RuntimeOverrides,
): Promise<RuntimeApplication> {
  return queueSettings(context, async () => {
    if (isDisposed(context)) return { kind: "applied", createdGateway: null }
    const { authentication, ...options } = explicit
    const next = runtimeOptionsSchema.parse({
      ...context.session.runtime,
      ...options,
    })
    const nextAuthentication = authentication ?? context.session.authentication
    const changed =
      JSON.stringify(next) !== JSON.stringify(context.session.runtime)
      || JSON.stringify(nextAuthentication)
        !== JSON.stringify(context.session.authentication)
    if (!changed) return { kind: "applied", createdGateway: null }
    const previous = context.state.settings
    const settings = {
      ...previous,
      port: next.port,
      accountType: next.accountType,
    }
    const previousRuntime = context.settingsStore.runtime()
    let runtimeSaved = false
    if (context.account.credentialSource !== "session-override") {
      await persistRuntime(context, {
        runtime: next,
        authentication: nextAuthentication,
        settings,
      })
      runtimeSaved = true
    }
    if (!(await drainReplacement(context))) {
      if (runtimeSaved) {
        try {
          await context.settingsStore.save(previous, previousRuntime)
        } catch {
          // Keep the preserved runtime result even if rollback fails.
        }
      }
      return { kind: "preserved" }
    }
    if (isDisposed(context)) return { kind: "applied", createdGateway: null }
    activateRuntime(context, {
      runtime: next,
      authentication: nextAuthentication,
    })
    if (next.accountType !== previous.accountType && !isDisposed(context))
      await context.refresh({ allowLegacyDiscovery: false })
    if (isDisposed(context)) return { kind: "applied", createdGateway: null }
    const createdGateway = await convergeGateway(context)
    if (!isDisposed(context)) await context.inspectConfigs()
    return { kind: "applied", createdGateway }
  })
}
function matchesLease(
  context: ControllerContext,
  expected: CreatorLease,
): boolean {
  return (
    context.sessionId === expected.sessionId
    && context.session.gatewayGeneration === expected.gatewayGeneration
  )
}
export async function changeNativeGateway(
  context: ControllerContext,
  intent: Extract<
    NativeIntent,
    { kind: "update-runtime" | "stop-gateway" | "drain-gateway" }
  >,
): Promise<NativeOperationResult | null> {
  if (intent.kind === "update-runtime") {
    const unsupported = unsupportedRuntime(intent.explicit)
    if (unsupported) return unsupported
    const result = await applyRuntime(context, intent.explicit)
    return result.kind === "applied" ?
        result
      : {
          kind: "unavailable",
          message:
            "The running gateway is still serving an agent request. Its configuration was preserved.",
        }
  }
  if (!matchesLease(context, intent.expected))
    return { kind: "session-changed", snapshot: createServiceSnapshot(context) }
  if (intent.kind === "stop-gateway") {
    await setGatewayDesired(context, false)
    return matchesLease(context, intent.expected) ? null : (
        { kind: "session-changed", snapshot: createServiceSnapshot(context) }
      )
  }
  return serializeGateway(context, async () => {
    const changed = () => ({
      kind: "session-changed" as const,
      snapshot: createServiceSnapshot(context),
    })
    if (!matchesLease(context, intent.expected)) return changed()
    const target = context.session.owned
    if (!target?.ready) return null
    context.publish({ gateway: { kind: "draining", inFlight: 0 } })
    const attempt = await requestDrain(target, intent.timeoutMs)
    if (attempt.kind === "stopped") {
      if (context.session.owned === target) context.session.owned = undefined
      clearDrainingIfStopped(context)
      return changed()
    }
    if (
      !matchesLease(context, intent.expected)
      || context.session.owned !== target
    ) {
      clearDrainingIfStopped(context)
      return changed()
    }
    if (attempt.kind === "failed" || attempt.result.kind === "timeout") {
      await resumeOrCleanUpDraining(context, target)
      return {
        kind: "unavailable" as const,
        message:
          "The gateway is still serving an agent request. It was preserved.",
      }
    }
    return null
  })
}
