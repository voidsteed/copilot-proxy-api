import { randomUUID } from "node:crypto"
import { join } from "node:path"

import type {
  AgentModel,
  ConfigurableAgent,
  ControlResult,
  ModelSelectableAgent,
  NativeConnection,
  NativeIntent,
  NativeSessionAuthority,
  NativeSnapshot,
  ServiceSnapshot,
} from "../../src/lib/proxy-contracts"
import type {
  ControllerContext,
  NativeOperationResult,
  RefreshOptions,
} from "./controller-session"
import type { ControllerOptions, DesktopController } from "./types"

import {
  configureMissingAgent,
  getAgentConfigFolder,
} from "../../src/lib/agent-config"
import { inspectLaunchAgents } from "../../src/lib/launch-agent-diagnostics"
import {
  nativeIntentSchema,
  sessionIdSchema,
} from "../../src/lib/proxy-contracts"
import { fixtureOriginSchema } from "../engine/upstream"
import { supportsAgent } from "../shared/connections"
import {
  type CommandOutcome,
  type CommandResponse,
  commandSchema,
  type DesktopCommand,
  type DesktopModel,
  type DesktopSettings,
  type DesktopSnapshot,
} from "../shared/contracts"
import { createClipboardText } from "./clipboard"
import {
  authorizeNativeAccount,
  beginSignIn,
  cancelAuthorization,
  createControllerAccountState,
  detachLegacy,
  ensureNativeAccount,
  refresh,
  restore,
  rotateKey,
  signOut,
} from "./controller-account"
import {
  activateRuntime,
  changeNativeGateway,
  convergeGateway,
  createControllerSessionState,
  drainReplacement,
  isDisposed,
  queueSettings,
  setGatewayDesired,
} from "./controller-session"
import { DEVICE_PAGE } from "./oauth"
import {
  createSettingsStore,
  mergeSettingsPatch,
  persistSettings,
} from "./settings-store"
import {
  createNativeSnapshot,
  createNativeSource,
  defaultRuntimeOptions,
  initialSnapshot,
  inspectAllAgents,
  proposeAgentModel,
  runGatewayProbe,
  shouldClearConfigureResult,
} from "./snapshot"

const PASSIVE_COMMANDS = new Set<DesktopCommand["kind"]>([
  "inspect-agent-config",
  "inspect-launch-agent",
  "open-config-folder",
  "clear-probe",
])
const CLOSED_OUTCOME: CommandOutcome = {
  kind: "rejected",
  message: "The desktop controller is closed.",
}
class Controller implements DesktopController {
  private readonly context: ControllerContext
  constructor(
    options: ControllerOptions,
    settingsStore: ReturnType<typeof createSettingsStore>,
    loaded: Awaited<ReturnType<typeof settingsStore.load>>,
  ) {
    const fixtureOrigin =
      options.fixtureOrigin === undefined ?
        undefined
      : fixtureOriginSchema.parse(options.fixtureOrigin)
    const settings =
      loaded.runtime ?
        {
          ...loaded.settings,
          port: loaded.runtime.options.port,
          accountType: loaded.runtime.options.accountType,
        }
      : loaded.settings
    const sessionId = sessionIdSchema.parse(randomUUID())
    this.context = {
      options,
      homeDirectory: options.homeDirectory ?? options.dataDirectory,
      stateDirectory:
        options.stateDirectory ?? join(options.dataDirectory, "native"),
      fixtureOrigin,
      sessionId,
      settingsStore,
      state: initialSnapshot({
        sessionId,
        version: options.version,
        platform: options.platform,
        fixture: fixtureOrigin !== undefined,
        storageMode: options.vault.mode,
        settings,
        recovered: loaded.recovered,
      }),
      account: createControllerAccountState(),
      session: createControllerSessionState(
        loaded.runtime?.options ?? defaultRuntimeOptions(loaded.settings),
      ),
      publish: (patch) => this.publish(patch),
      notice: (message, kind) => this.notice(message, kind),
      own: (task) => this.own(task),
      inspectConfigs: (inspectOptions) => this.inspectConfigs(inspectOptions),
      refresh: (refreshOptions?: RefreshOptions) =>
        refresh(this.context, refreshOptions),
      activeConnection: this.activeConnection,
      nativeSource: () => this.nativeSource(),
    }
    this.context.state.source = this.nativeSource()
  }
  async restore(): Promise<void> {
    await restore(this.context)
  }
  private configInspection = 0
  private launchInspection = 0
  private disposal: Promise<void> | undefined
  private readonly background = new Set<Promise<void>>()
  private readonly listeners = new Set<(snapshot: DesktopSnapshot) => void>()
  private readonly serviceListeners = new Set<
    (snapshot: ServiceSnapshot) => void
  >()
  snapshot = (): DesktopSnapshot => structuredClone(this.context.state)
  activeConnection = (): NativeConnection | null => {
    if (this.context.state.gateway.kind !== "running") return null
    if (
      this.context.session.legacy
      && this.context.session.legacySnapshot?.status === "reachable"
      && this.context.session.legacyConnection
    )
      return structuredClone(this.context.session.legacyConnection)
    return this.context.session.owned?.ready ?
        structuredClone(this.context.session.owned.connection)
      : null
  }
  agentProposal = (
    target: ModelSelectableAgent,
  ): Extract<AgentModel, { kind: "proposed" }> | null =>
    proposeAgentModel(this.context.state, target)
  private nativeSource(): Extract<
    DesktopSnapshot["source"],
    { kind: "native-managed" }
  > {
    return createNativeSource(this.context)
  }
  private nativeSnapshot(): NativeSnapshot {
    return createNativeSnapshot(this.context)
  }
  private serviceSnapshot = (): ServiceSnapshot =>
    this.context.session.legacySnapshot ?
      structuredClone(this.context.session.legacySnapshot)
    : this.nativeSnapshot()
  sessionApi = (): NativeSessionAuthority => ({
    snapshot: this.serviceSnapshot,
    connection: this.activeConnection,
    dispatch: (intent) =>
      this.context.session.disposed ?
        Promise.resolve({
          kind: "unavailable" as const,
          message: "The native proxy session is unavailable.",
        })
      : this.dispatchNative(intent),
    subscribe: (listener) => {
      this.serviceListeners.add(listener)
      try {
        listener(this.serviceSnapshot())
      } catch (error) {
        this.serviceListeners.delete(listener)
        throw error
      }
      return () => this.serviceListeners.delete(listener)
    },
  })
  private publish(patch: Partial<DesktopSnapshot>): void {
    this.context.state = {
      ...this.context.state,
      ...patch,
      revision: this.context.state.revision + 1,
    }
    if (this.context.session.disposed) return
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot())
      } catch {
        continue
      }
    }
    for (const listener of this.serviceListeners) {
      try {
        listener(this.serviceSnapshot())
      } catch {
        continue
      }
    }
  }
  private notice(message: string, kind: "info" | "error" = "error"): void {
    this.publish({ notice: { kind, message } })
  }
  private reject(message: string): CommandOutcome {
    this.notice(message)
    return { kind: "rejected", message }
  }
  private own(task: Promise<void>): void {
    const guarded = task
      .catch(() => {
        if (!this.context.session.disposed)
          this.notice("The action could not be completed. Try again.")
      })
      .finally(() => this.background.delete(guarded))
    this.background.add(guarded)
  }
  private async inspectConfigs(options?: {
    clearStaleTarget?: ConfigurableAgent
  }): Promise<void> {
    const inspection = ++this.configInspection
    const launchId = ++this.launchInspection
    const { agentConfigs, launchAgentDiagnostics } = await inspectAllAgents({
      homeDirectory: this.context.homeDirectory,
      connection: this.activeConnection(),
      state: this.context.state,
    })
    if (
      !this.context.session.disposed
      && inspection === this.configInspection
    ) {
      const clearResult = shouldClearConfigureResult({
        prior: this.context.state.lastConfigureResult,
        views: agentConfigs,
        clearStaleTarget: options?.clearStaleTarget,
      })
      this.publish({
        agentConfigs,
        ...(launchId === this.launchInspection ?
          { launchAgentDiagnostics }
        : {}),
        ...(clearResult ? { lastConfigureResult: null } : {}),
      })
    }
  }
  private async inspectLaunchDiagnostics(): Promise<void> {
    const launchId = ++this.launchInspection
    const launchAgentDiagnostics = await inspectLaunchAgents(
      this.context.homeDirectory,
    )
    if (!this.context.session.disposed && launchId === this.launchInspection)
      this.publish({ launchAgentDiagnostics })
  }
  private persistedSettings(settings: DesktopSettings): DesktopSettings {
    if (!this.context.session.legacy) return settings
    const options =
      this.context.settingsStore.runtime()?.options
      ?? this.context.session.runtime
    return { ...settings, port: options.port, accountType: options.accountType }
  }
  private saveSettings(
    change: (current: DesktopSettings) => DesktopSettings,
  ): Promise<CommandOutcome> {
    return queueSettings(this.context, async () => {
      if (isDisposed(this.context)) return CLOSED_OUTCOME
      const displayedPrevious = this.context.state.settings
      const displayedNext = change(displayedPrevious)
      const restart =
        displayedNext.port !== displayedPrevious.port
        || displayedNext.accountType !== displayedPrevious.accountType
      if (restart && this.context.session.legacy)
        return this.reject(
          "The CLI gateway's runtime settings are managed in Terminal.",
        )
      const previousRuntime = this.context.settingsStore.runtime()
      const previous = this.persistedSettings(displayedPrevious)
      const next = this.persistedSettings(displayedNext)
      const saved = await persistSettings({
        previous,
        next,
        applyLoginItem: this.context.options.applyLoginItem?.bind(
          this.context.options,
        ),
        save: (settings) =>
          this.context.settingsStore.save(
            settings,
            previousRuntime && !this.context.session.legacy ?
              {
                ...previousRuntime,
                options: {
                  ...previousRuntime.options,
                  port: next.port,
                  accountType: next.accountType,
                },
              }
            : previousRuntime,
          ),
      })
      if (saved.kind !== "saved") return this.reject(saved.message)
      if (this.disposal) return CLOSED_OUTCOME
      if (restart && !(await drainReplacement(this.context))) {
        await persistSettings({
          previous: next,
          next: previous,
          applyLoginItem: this.context.options.applyLoginItem?.bind(
            this.context.options,
          ),
          save: (settings) =>
            this.context.settingsStore.save(settings, previousRuntime),
        }).catch(() => undefined)
        return this.reject(
          "The gateway is still serving an agent request. Its running configuration was preserved.",
        )
      }
      if (isDisposed(this.context)) return CLOSED_OUTCOME
      this.publish({ settings: displayedNext })
      if (restart) {
        activateRuntime(this.context, {
          runtime: {
            ...this.context.session.runtime,
            port: next.port,
            accountType: next.accountType,
          },
          authentication: this.context.session.authentication,
        })
        if (next.accountType !== previous.accountType)
          await refresh(this.context, { allowLegacyDiscovery: false })
        await convergeGateway(this.context)
      }
      await this.inspectConfigs()
      return { kind: "ok" }
    })
  }
  private getModel(id: string): DesktopModel | undefined {
    return this.context.state.models.find((model) => model.id === id)
  }
  execute = async (input: unknown): Promise<CommandResponse> => {
    if (this.context.session.disposed)
      return { snapshot: this.snapshot(), outcome: CLOSED_OUTCOME }
    const parsed = commandSchema.safeParse(input)
    if (!parsed.success)
      return {
        outcome: this.reject("The app received an invalid command."),
        snapshot: this.snapshot(),
      }
    const command = parsed.data
    if (!PASSIVE_COMMANDS.has(command.kind)) this.publish({ notice: null })
    let outcome: CommandOutcome
    try {
      outcome = await this.dispatch(command)
    } catch {
      outcome = this.reject("The action could not be completed. Try again.")
    }
    return { snapshot: this.snapshot(), outcome }
  }
  invoke = async (input: unknown): Promise<DesktopSnapshot> =>
    (await this.execute(input)).snapshot
  private dispatch(command: DesktopCommand): Promise<CommandOutcome> {
    switch (command.kind) {
      case "copy":
      case "copy-config": {
        return this.handleClipboardCommand(command)
      }
      case "start-gateway":
      case "stop-gateway":
      case "detach-legacy":
      case "clear-probe":
      case "rotate-key":
      case "run-probe": {
        return this.handleGatewayCommand(command)
      }
      case "save-settings":
      case "select-model":
      case "select-agent-model":
      case "inspect-agent-config":
      case "inspect-launch-agent":
      case "open-config-folder":
      case "configure-agent": {
        return this.handleConfigurationCommand(command)
      }
      default: {
        return this.handleAccountCommand(command)
      }
    }
  }
  private async handleClipboardCommand(
    command: Extract<DesktopCommand, { kind: "copy" | "copy-config" }>,
  ): Promise<CommandOutcome> {
    const authorization = this.context.state.authorization
    const result = createClipboardText({
      command,
      connection: this.activeConnection(),
      models: this.context.state.models,
      agentConfigs: this.context.state.agentConfigs,
      deviceCode: authorization.kind === "awaiting" ? authorization.code : null,
    })
    if (result.kind === "error") return this.reject(result.message)
    await this.context.options.writeClipboard(result.text)
    return { kind: "ok" }
  }
  private async handleStartGateway(): Promise<CommandOutcome> {
    if (
      this.context.session.legacy
      && this.context.session.legacySnapshot?.status === "unreachable"
    )
      await detachLegacy(this.context, { restoreAccount: true })
    if (this.context.session.legacy) return refresh(this.context)
    if (this.context.account.restoring) await this.context.account.restoring
    if (
      !this.context.account.credentials
      || this.context.state.account.kind !== "signed-in"
    )
      return this.reject("Sign in to GitHub before starting the gateway.")
    await setGatewayDesired(this.context, true)
    return this.context.state.gateway.kind === "error" ?
        { kind: "rejected", message: this.context.state.gateway.message }
      : { kind: "ok" }
  }
  private async handleGatewayCommand(
    command: Extract<
      DesktopCommand,
      {
        kind:
          | "start-gateway"
          | "stop-gateway"
          | "detach-legacy"
          | "clear-probe"
          | "rotate-key"
          | "run-probe"
      }
    >,
  ): Promise<CommandOutcome> {
    switch (command.kind) {
      case "start-gateway": {
        return this.handleStartGateway()
      }
      case "stop-gateway": {
        if (this.context.session.legacy)
          return this.reject(
            "This gateway is running in Terminal. Manage its process there.",
          )
        await setGatewayDesired(this.context, false)
        return { kind: "ok" }
      }
      case "detach-legacy": {
        return detachLegacy(this.context, { restoreAccount: true })
      }
      case "clear-probe": {
        this.context.session.probeAbort?.abort()
        this.context.session.probeAbort = undefined
        this.publish({ probe: { kind: "idle" } })
        return { kind: "ok" }
      }
      case "rotate-key": {
        return rotateKey(this.context)
      }
      case "run-probe": {
        const model = this.getModel(command.modelId)
        if (!model) {
          const message =
            "Choose an available model before sending a test request."
          this.publish({ probe: { kind: "error", message } })
          return { kind: "rejected", message }
        }
        if (!this.activeConnection()) {
          const message = "Start the gateway before sending a test request."
          this.publish({ probe: { kind: "error", message } })
          return { kind: "rejected", message }
        }
        this.own(runGatewayProbe(this.context, model, command.prompt))
        return { kind: "ok" }
      }
      default: {
        const exhaustive: never = command
        return exhaustive
      }
    }
  }
  private async handleConfigurationCommand(
    command: Extract<
      DesktopCommand,
      {
        kind:
          | "save-settings"
          | "select-model"
          | "select-agent-model"
          | "inspect-agent-config"
          | "inspect-launch-agent"
          | "open-config-folder"
          | "configure-agent"
      }
    >,
  ): Promise<CommandOutcome> {
    switch (command.kind) {
      case "save-settings": {
        return this.saveSettings((current) =>
          mergeSettingsPatch(current, command.settings),
        )
      }
      case "select-model": {
        if (!this.getModel(command.modelId))
          return this.reject(
            "This model is no longer available. Refresh the model catalog.",
          )
        return this.saveSettings((current) => ({
          ...current,
          preferredModel: command.modelId,
        }))
      }
      case "select-agent-model": {
        const model = this.getModel(command.modelId)
        if (!model || !supportsAgent(model, command.target))
          return this.reject(
            "Choose an available model that supports this agent's API.",
          )
        return this.saveSettings((current) => ({
          ...current,
          agentModelChoices: {
            ...current.agentModelChoices,
            [command.target]: command.modelId,
          },
        }))
      }
      case "inspect-agent-config": {
        await this.inspectConfigs({ clearStaleTarget: command.target })
        return { kind: "ok" }
      }
      case "inspect-launch-agent": {
        await this.inspectLaunchDiagnostics()
        return { kind: "ok" }
      }
      case "open-config-folder": {
        if (!this.context.options.openFolder)
          return this.reject(
            "Opening configuration folders is unavailable in this session.",
          )
        await this.context.options.openFolder(
          getAgentConfigFolder(command.target, this.context.homeDirectory),
        )
        return { kind: "ok" }
      }
      case "configure-agent": {
        const connection = this.activeConnection()
        if (!connection)
          return this.reject("Start the proxy before configuring an agent.")
        const result = await configureMissingAgent({
          homeDirectory: this.context.homeDirectory,
          target: command.target,
          connection,
          catalog: this.context.state.models,
          proposal: this.agentProposal(command.target),
        })
        this.publish({ lastConfigureResult: result })
        await this.inspectConfigs()
        if (result.kind === "conflict")
          return this.reject(
            "Existing configuration values were preserved. Review the fields that point to another proxy.",
          )
        if (result.kind === "invalid") return this.reject(result.message)
        return { kind: "ok" }
      }
      default: {
        const exhaustive: never = command
        return exhaustive
      }
    }
  }
  private async handleAccountCommand(
    command: Extract<
      DesktopCommand,
      {
        kind:
          | "sign-in"
          | "cancel-sign-in"
          | "open-device-page"
          | "sign-out"
          | "refresh"
          | "clear-activity"
          | "dismiss-notice"
      }
    >,
  ): Promise<CommandOutcome> {
    switch (command.kind) {
      case "sign-in": {
        if (
          this.context.session.legacy
          && this.context.session.legacySnapshot?.status === "unreachable"
        )
          await detachLegacy(this.context, { restoreAccount: false })
        return beginSignIn(this.context)
      }
      case "cancel-sign-in": {
        cancelAuthorization(this.context)
        return { kind: "ok" }
      }
      case "open-device-page": {
        if (this.context.state.authorization.kind !== "awaiting")
          return {
            kind: "rejected",
            message: "No sign-in verification page is active.",
          }
        await this.context.options.openExternal(DEVICE_PAGE)
        return { kind: "ok" }
      }
      case "sign-out": {
        return signOut(this.context)
      }
      case "refresh": {
        return refresh(this.context)
      }
      case "clear-activity": {
        if (this.context.session.legacy)
          return this.reject(
            "The CLI retains this activity history. Its totals are not available.",
          )
        this.publish({ activity: [] })
        return { kind: "ok" }
      }
      case "dismiss-notice": {
        return { kind: "ok" }
      }
      default: {
        const exhaustive: never = command
        return exhaustive
      }
    }
  }
  private async dispatchNative(input: NativeIntent): Promise<ControlResult> {
    const parsed = nativeIntentSchema.safeParse(input)
    if (!parsed.success)
      return {
        kind: "unavailable",
        message: "The native proxy session is unavailable.",
      }
    const intent = parsed.data
    if (intent.kind === "show-ui") return this.showNativeUi()
    const immediate = await this.readOnlyNativeResult(intent)
    if (immediate) return immediate
    try {
      let result: NativeOperationResult | null = null
      switch (intent.kind) {
        case "authorize":
        case "cancel-authorization":
        case "authorize-with-token": {
          result = await authorizeNativeAccount(this.context, intent)
          break
        }
        case "ensure-running": {
          result = await ensureNativeAccount(this.context, intent)
          break
        }
        case "update-runtime":
        case "stop-gateway":
        case "drain-gateway": {
          result = await changeNativeGateway(this.context, intent)
          break
        }
        case "sign-out": {
          await signOut(this.context)
          break
        }
        case "refresh": {
          await refresh(this.context)
          break
        }
        case "clear-activity": {
          this.publish({ activity: [] })
          break
        }
        default: {
          const exhaustive: never = intent
          return exhaustive
        }
      }
      return this.nativeResult(result)
    } catch {
      return {
        kind: "unavailable",
        message: "The requested proxy action could not be completed.",
      }
    }
  }
  private nativeResult(result: NativeOperationResult | null): ControlResult {
    if (result && result.kind !== "applied") return result
    if (this.context.session.legacy)
      return { kind: "session-changed", snapshot: this.serviceSnapshot() }
    const createdGateway = result?.createdGateway ?? null
    return {
      kind: "applied",
      snapshot: this.nativeSnapshot(),
      createdGateway:
        (
          createdGateway
          && this.context.session.owned?.ready
          && createdGateway.sessionId === this.context.sessionId
          && createdGateway.gatewayGeneration
            === this.context.session.owned.generation
        ) ?
          createdGateway
        : null,
    }
  }
  private async readOnlyNativeResult(
    intent: NativeIntent,
  ): Promise<ControlResult | null> {
    if (this.context.session.legacy) {
      if (intent.kind === "refresh") await refresh(this.context)
      return { kind: "session-changed", snapshot: this.serviceSnapshot() }
    }
    return null
  }
  private async showNativeUi(): Promise<ControlResult> {
    await this.context.options.showUi?.()
    return this.context.session.legacySnapshot ?
        { kind: "session-changed", snapshot: this.serviceSnapshot() }
      : this.nativeResult(null)
  }
  subscribe = (listener: (snapshot: DesktopSnapshot) => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  dispose = (): Promise<void> => {
    this.disposal ??= (async () => {
      this.context.session.disposed = true
      this.context.session.disposeAbort.abort()
      this.context.account.attempt?.abort.abort()
      this.context.account.attempt = undefined
      this.context.account.accountGeneration++
      this.context.account.refreshAbort?.abort()
      this.context.session.probeAbort?.abort()
      this.context.session.desiredGateway = false
      this.context.session.legacyUnsubscribe?.()
      this.context.session.legacyUnsubscribe = undefined
      this.listeners.clear()
      this.serviceListeners.clear()
      if (this.context.session.legacy)
        await this.context.session.legacy.release()
      if (this.context.session.owned)
        await this.context.session.owned.process.stop()
      this.context.session.owned = undefined
      await Promise.allSettled([
        ...this.background,
        this.context.session.settingsWrites,
        this.context.account.storage,
        this.context.session.reconciliation?.promise,
        this.context.session.gatewayQueue,
      ])
      this.context.account.credentials = null
    })()
    return this.disposal
  }
}
export async function createController(
  options: ControllerOptions,
): Promise<DesktopController> {
  const settingsStore = createSettingsStore(
    options.dataDirectory,
    options.platform === "win32" ? "powershell" : "posix",
  )
  const controller = new Controller(
    options,
    settingsStore,
    await settingsStore.load(),
  )
  await controller.restore()
  return controller
}
