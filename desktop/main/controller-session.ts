import type {
  ControlResult,
  CreatorLease,
  NativeIntent,
} from "../../src/lib/proxy-contracts"
import type {
  CompletedActivity,
  LegacySession,
  LegacySnapshot,
  NativeConnection,
  RuntimeOptions,
  RuntimeOverrides,
} from "../../src/lib/proxy-contracts"
import type { ControllerAccountState } from "./controller-account"
import type { ControllerOptions } from "./types"

import { configuredProxyConnections } from "../../src/lib/agent-config"
import { probeLegacyProxy } from "../../src/lib/legacy-proxy"
import {
  gatewayGenerationSchema,
  nativeConnectionSchema,
  publicConnectionSchema,
  runtimeOptionsSchema,
  sessionIdSchema,
} from "../../src/lib/proxy-contracts"
import { type DesktopSnapshot } from "../shared/contracts"
import { gatewayError } from "./failure-messages"
import { type ProxyProcess, startProxyProcess } from "./proxy-process"
import {
  createSettingsStore,
  type NativeRuntimeSettings,
} from "./settings-store"
import { createServiceSnapshot } from "./snapshot"
import { appendActivity } from "./snapshot"
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
  legacy: LegacySession | undefined
  legacySnapshot: LegacySnapshot | undefined
  legacyConnection: NativeConnection | undefined
  legacyUnsubscribe: (() => void) | undefined
  legacyStartedAt: string | undefined
  discovery: Promise<boolean> | undefined
  reconciliation: Promise<void> | undefined
  probeAbort: AbortController | undefined
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
  inspectConfigs(): Promise<void>
  refresh(): Promise<void>
  activeConnection(): NativeConnection | null
  nativeSource(): Extract<
    DesktopSnapshot["source"],
    {
      kind: "native-managed"
    }
  >
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
    probeAbort: undefined,
    disposed: false,
    settingsWrites: Promise.resolve(),
  }
}
export function applyLegacy(
  context: ControllerContext,
  snapshot: LegacySnapshot,
): void {
  context.session.legacySnapshot = snapshot
  const actualPort = Number(new URL(snapshot.connection.rootUrl).port)
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
    settings: { ...context.state.settings, port: actualPort },
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
  options: {
    legacy: LegacySession
    connection: NativeConnection
  },
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
  const legacy = await probeLegacyProxy({ connection })
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
): Promise<Map<string, [NativeConnection, ...Array<NativeConnection>]>> {
  const configured = await configuredProxyConnections(context.homeDirectory)
  if (
    context.options.homeDirectory !== undefined
    || context.state.settings.port !== 4141
  )
    configured.push(
      nativeConnectionSchema.parse({
        rootUrl:
          "http://localhost:" + String(context.state.settings.port) + "/",
        apiUrl:
          "http://localhost:" + String(context.state.settings.port) + "/v1",
        authentication: { kind: "none" },
      }),
    )
  const endpoints = new Map<
    string,
    [NativeConnection, ...Array<NativeConnection>]
  >()
  for (const connection of configured) {
    const port = new URL(connection.rootUrl).port
    const candidates = endpoints.get(port)
    if (candidates) candidates.push(connection)
    else endpoints.set(port, [connection])
  }
  for (const candidates of endpoints.values()) {
    const first = candidates[0]
    if (context.account.credentials)
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
  }
  return endpoints
}
export function discoverLegacy(context: ControllerContext): Promise<boolean> {
  if (context.session.legacy) return Promise.resolve(true)
  if (context.session.discovery) return context.session.discovery
  const task = (async () => {
    const endpoints = await legacyCandidates(context)
    for (const candidates of endpoints.values())
      for (const connection of candidates) {
        if (!canDiscover(context)) return false
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
  process: ProxyProcess,
  expected: boolean,
): void {
  if (
    expected
    || context.session.disposed
    || context.session.owned?.process !== process
  )
    return
  context.session.owned = undefined
  context.session.desiredGateway = false
  context.session.probeAbort?.abort()
  context.publish({
    connection: null,
    runtime: null,
    gateway: {
      kind: "error",
      message: "The gateway exited unexpectedly. Start it again to reconnect.",
    },
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
export async function drainReplacement(
  context: ControllerContext,
  target: OwnedGateway,
  options: {
    timeoutMs?: number
    current?: () => boolean
  } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 15000
  const current = options.current ?? (() => true)
  if (context.session.owned !== target) return true
  context.publish({ gateway: { kind: "draining", inFlight: 0 } })
  const result = await target.process.drain(timeoutMs)
  if (context.session.owned !== target) return true
  if (result.kind === "timeout" || !current()) {
    await target.process.resume()
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
  await target.process.stop()
  if (context.session.owned === target) context.session.owned = undefined
  context.publish({
    gateway: { kind: "stopped" },
    connection: null,
    runtime: null,
  })
  return true
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
    rootUrl: "http://127.0.0.1:" + String(runtime.port) + "/",
    apiUrl: "http://127.0.0.1:" + String(runtime.port) + "/v1",
    authentication:
      authentication.kind === "none" ?
        authentication
      : { kind: "keyed", key: authentication.keys[0] },
  })
  context.publish({ gateway: { kind: "starting" } })
  if (!canRunGateway(context, revision)) return { kind: "retry" }
  let process: ProxyProcess
  try {
    process = startProxyProcess({
      runtimePath: context.options.runtimePath,
      runtimeExecPath: context.options.runtimeExecPath,
      init: {
        kind: "init",
        githubToken: credentials.githubToken,
        gatewayKey: credentials.gatewayKey,
        authentication,
        port: runtime.port,
        accountType: runtime.accountType,
        options: runtime,
        fixtureOrigin: context.fixtureOrigin,
      },
      onActivity: (record) => {
        if (accountGeneration === context.account.accountGeneration)
          recordActivity(context, process, record)
      },
      onDraining: (inFlight) => {
        if (
          context.session.owned?.process === process
          && context.state.gateway.kind === "draining"
        )
          context.publish({ gateway: { kind: "draining", inFlight } })
      },
      onExit: (expected) => processExited(context, process, expected),
    })
    context.session.gatewayGeneration = gatewayGenerationSchema.parse(
      context.session.gatewayGeneration + 1,
    )
    const owned: OwnedGateway = {
      process,
      revision,
      generation: context.session.gatewayGeneration,
      ready: false,
      startedAt: new Date().toISOString(),
      connection,
      runtime,
    }
    context.session.owned = owned
    context.publish({ source: context.nativeSource() })
    await process.ready
    owned.ready = true
    await applyCurrentCatalog(context, process, revision)
    if (canRunGateway(context, revision)) {
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
      const createdGateway = {
        sessionId: context.sessionId,
        gatewayGeneration: owned.generation,
      }
      return {
        kind: "settled",
        createdGateway,
      }
    }
  } catch (error) {
    if (!canRunGateway(context, revision)) return { kind: "retry" }
    context.session.desiredGateway = false
    await stopOwnedGateway(context, context.session.owned)
    context.publish({
      gateway: { kind: "error", message: gatewayError(error) },
      connection: null,
      runtime: null,
    })
    return { kind: "settled", createdGateway: null }
  }
  return { kind: "retry" }
}
async function stopOwnedGateway(
  context: ControllerContext,
  previous: OwnedGateway | undefined,
): Promise<void> {
  if (!previous) return
  await previous.process.stop()
  if (context.session.owned === previous) context.session.owned = undefined
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
  context.session.configurationRevision = previous.revision
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
    if (await drainReplacement(context, previous)) return true
    restoreOwnedRuntime(context, previous, revision)
    context.notice(
      "The gateway is still serving an agent request. Its running configuration was preserved. Try again after the request finishes.",
    )
    return false
  }
  context.publish({ gateway: { kind: "stopping" } })
  await stopOwnedGateway(context, previous)
  context.publish({
    gateway: { kind: "stopped" },
    connection: null,
    runtime: null,
  })
  return true
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
      !canRunGateway(context)
      || !context.account.credentials
      || context.session.owned
    )
      return null
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
export function convergeGateway(
  context: ControllerContext,
): Promise<GatewayCreationReceipt> {
  if (context.session.reconciliation)
    return context.session.reconciliation.then(() => null)
  const creation = Promise.resolve().then(() => reconcile(context))
  const completion = creation
    .then(() => undefined)
    .finally(() => {
      if (context.session.reconciliation !== completion) return
      context.session.reconciliation = undefined
      const unsettled =
        context.session.owned ?
          !canRunGateway(context, context.session.owned.revision)
        : canRunGateway(context) && context.account.credentials !== null
      if (unsettled) return convergeGateway(context).then(() => undefined)
    })
  context.session.reconciliation = completion
  return creation.then(async (receipt) => {
    await completion
    return receipt
  })
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
    if (!context.session.owned)
      context.publish({
        gateway: { kind: "stopped" },
        connection: null,
        runtime: null,
      })
    else context.own(context.session.owned.process.stop())
  } else if (
    context.session.owned?.ready
    && context.state.gateway.kind === "draining"
  ) {
    return context.session.owned.process
      .resume()
      .then(() =>
        context.publish({
          gateway: {
            kind: "running",
            url: context.session.owned?.connection.apiUrl ?? "",
            startedAt: new Date().toISOString(),
          },
        }),
      )
      .then(() => convergeGateway(context))
  }
  return convergeGateway(context).then((receipt) => (running ? receipt : null))
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
  const { runtime, authentication } = options
  let encryptedAuthentication: string | null = null
  if (
    authentication.kind === "keyed"
    && context.options.vault.mode === "encrypted"
  ) {
    if (!context.options.vault.encodeRuntimeAuthentication)
      throw new Error("Encrypted gateway settings are unavailable.")
    encryptedAuthentication =
      await context.options.vault.encodeRuntimeAuthentication(authentication)
    if (!encryptedAuthentication)
      throw new Error("Encrypted gateway settings could not be saved.")
  }
  const metadata: NativeRuntimeSettings = {
    options: runtime,
    authentication: { kind: authentication.kind },
    encryptedAuthentication,
  }
  const settings = options.settings ?? {
    ...context.state.settings,
    port: runtime.port,
    accountType: runtime.accountType,
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
    await persistRuntime(context, {
      runtime: next,
      authentication: nextAuthentication,
      settings,
    })
    const target = context.session.owned
    if (target && !(await drainReplacement(context, target))) {
      await context.settingsStore.save(previous, previousRuntime)
      return { kind: "preserved" }
    }
    activateRuntime(context, {
      runtime: next,
      authentication: nextAuthentication,
    })
    if (next.accountType !== previous.accountType) await context.refresh()
    const createdGateway = await convergeGateway(context)
    await context.inspectConfigs()
    return { kind: "applied", createdGateway }
  })
}
export function unsupportedRuntime(
  explicit: RuntimeOverrides,
): ControlResult | null {
  return explicit.manualApprove === true ?
      {
        kind: "unavailable",
        message:
          "Manual approval is unavailable for a gateway managed by the desktop app.",
      }
    : null
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
    {
      kind: "update-runtime" | "stop-gateway" | "drain-gateway"
    }
  >,
): Promise<NativeOperationResult | null> {
  if (intent.kind === "update-runtime") {
    const unsupported = unsupportedRuntime(intent.explicit)
    if (unsupported) return unsupported
  }
  if (intent.kind === "update-runtime") {
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
  const target = context.session.owned
  if (!target) return null
  context.publish({ gateway: { kind: "draining", inFlight: 0 } })
  const result = await target.process.drain(intent.timeoutMs)
  if (
    !matchesLease(context, intent.expected)
    || context.session.owned !== target
  )
    return { kind: "session-changed", snapshot: createServiceSnapshot(context) }
  if (result.kind === "timeout") {
    await target.process.resume()
    context.publish({
      gateway: {
        kind: "running",
        url: target.connection.apiUrl,
        startedAt: target.startedAt,
      },
    })
    return {
      kind: "unavailable",
      message:
        "The gateway is still serving an agent request. It was preserved.",
    }
  }
  return null
}
