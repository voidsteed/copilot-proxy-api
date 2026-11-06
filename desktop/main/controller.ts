import { randomUUID } from "node:crypto"
import { join } from "node:path"

import type {
  AgentModel,
  ConfigurableAgent,
  ControlResult,
  NativeConnection,
  NativeIntent,
  NativeSessionAuthority,
  NativeSnapshot,
  ServiceSnapshot,
} from "../../src/lib/proxy-contracts"
import type {
  ControllerContext,
  NativeOperationResult,
} from "./controller-session"
import type { ControllerOptions, DesktopController } from "./types"

import {
  configureMissingAgent,
  getAgentConfigFolder,
  inspectAgentConfigs,
} from "../../src/lib/agent-config"
import {
  nativeIntentSchema,
  runtimeOptionsSchema,
  sessionIdSchema,
} from "../../src/lib/proxy-contracts"
import { fixtureOriginSchema } from "../engine/upstream"
import { supportsAgent } from "../shared/connections"
import {
  commandSchema,
  type DesktopCommand,
  type DesktopModel,
  type DesktopSettings,
  type DesktopSnapshot,
} from "../shared/contracts"
import { createClipboardText } from "./clipboard"
import {
  authorizeNativeAccount,
  ensureNativeAccount,
} from "./controller-account"
import {
  createControllerAccountState,
  refresh,
  beginSignIn,
  cancelAuthorization,
  signOut,
  rotateKey,
  restore,
} from "./controller-account"
import { changeNativeGateway, activateRuntime } from "./controller-session"
import { queueSettings } from "./controller-session"
import {
  createControllerSessionState,
  applyLegacy,
  drainReplacement,
  convergeGateway,
  setGatewayDesired,
} from "./controller-session"
import { DEVICE_PAGE } from "./oauth"
import { executeProbe } from "./probe"
import { createSettingsStore, persistSettings } from "./settings-store"
import { createNativeSource, createNativeSnapshot } from "./snapshot"
import { initialSnapshot } from "./snapshot"
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
    this.context = {
      options,
      homeDirectory: options.homeDirectory ?? options.dataDirectory,
      stateDirectory:
        options.stateDirectory ?? join(options.dataDirectory, "native"),
      fixtureOrigin,
      sessionId: sessionIdSchema.parse(randomUUID()),
      settingsStore,
      state: initialSnapshot({
        version: options.version,
        platform: options.platform,
        fixture: fixtureOrigin !== undefined,
        storageMode: options.vault.mode,
        settings,
        recovered: loaded.recovered,
      }),
      account: createControllerAccountState(),
      session: createControllerSessionState(
        loaded.runtime?.options
          ?? runtimeOptionsSchema.parse({
            port: loaded.settings.port,
            accountType: loaded.settings.accountType,
            manualApprove: false,
            rateLimitSeconds: null,
            rateLimitWait: false,
            responsesContextTrim: false,
            proxyFromEnvironment: false,
          }),
      ),
      publish: (patch) => this.publish(patch),
      notice: (message, kind) => this.notice(message, kind),
      own: (task) => this.own(task),
      inspectConfigs: () => this.inspectConfigs(),
      refresh: () => refresh(this.context),
      activeConnection: this.activeConnection,
      nativeSource: () => this.nativeSource(),
    }
    this.context.state.source = this.nativeSource()
  }
  async restore(): Promise<void> {
    await restore(this.context)
  }
  private configInspection = 0
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
    target: ConfigurableAgent,
  ): Extract<
    AgentModel,
    {
      kind: "proposed"
    }
  > | null => {
    const selected = this.context.state.settings.agentModelChoices[target]
    const configured = this.context.state.models.find(
      (model) => model.id === selected && supportsAgent(model, target),
    )
    const compatible = this.context.state.models.filter((model) =>
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
  private nativeSource(): Extract<
    DesktopSnapshot["source"],
    {
      kind: "native-managed"
    }
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
      listener(this.serviceSnapshot())
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
  private own(task: Promise<void>): void {
    const guarded = task
      .catch(() => {
        if (!this.context.session.disposed)
          this.notice("The action could not be completed. Try again.")
      })
      .finally(() => this.background.delete(guarded))
    this.background.add(guarded)
  }
  private async inspectConfigs(): Promise<void> {
    const inspection = ++this.configInspection
    const views = await inspectAgentConfigs({
      homeDirectory: this.context.homeDirectory,
      connection: this.activeConnection(),
      catalog: this.context.state.models,
      proposals: {
        "claude-code": this.agentProposal("claude-code")?.catalogId ?? null,
        codex: this.agentProposal("codex")?.catalogId ?? null,
        opencode: this.agentProposal("opencode")?.catalogId ?? null,
      },
    })
    if (!this.context.session.disposed && inspection === this.configInspection)
      this.publish({ agentConfigs: views })
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
  ): Promise<void> {
    return queueSettings(this.context, async () => {
      if (this.context.session.disposed) return
      const displayedPrevious = this.context.state.settings
      const displayedNext = change(displayedPrevious)
      const restart =
        displayedNext.port !== displayedPrevious.port
        || displayedNext.accountType !== displayedPrevious.accountType
      if (restart && this.context.session.legacy) {
        this.notice(
          "The CLI gateway's runtime settings are managed in Terminal.",
        )
        return
      }
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
      if (saved !== "saved") {
        this.notice(
          saved === "unavailable" ?
            "Launch at login is unavailable in this session."
          : "Settings could not be saved. Check system permissions and try again.",
        )
        return
      }
      if (this.disposal) return
      const target = this.context.session.owned
      if (
        restart
        && target
        && !(await drainReplacement(this.context, target))
      ) {
        await persistSettings({
          previous: next,
          next: previous,
          applyLoginItem: this.context.options.applyLoginItem?.bind(
            this.context.options,
          ),
          save: (settings) =>
            this.context.settingsStore.save(settings, previousRuntime),
        })
        this.notice(
          "The gateway is still serving an agent request. Its running configuration was preserved.",
        )
        return
      }
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
          await refresh(this.context)
        await convergeGateway(this.context)
      }
      await this.inspectConfigs()
    })
  }
  private getModel(id: string): DesktopModel | undefined {
    return this.context.state.models.find((model) => model.id === id)
  }
  private async runProbe(model: DesktopModel, prompt: string): Promise<void> {
    const connection = this.activeConnection()
    if (!connection) {
      this.publish({
        probe: {
          kind: "error",
          message: "Start the gateway before sending a test request.",
        },
      })
      return
    }
    this.context.session.probeAbort?.abort()
    const abort = new AbortController()
    this.context.session.probeAbort = abort
    const revision = this.context.session.configurationRevision
    const current = () =>
      !this.context.session.disposed
      && !abort.signal.aborted
      && revision === this.context.session.configurationRevision
    this.publish({ probe: { kind: "running", model: model.id } })
    try {
      const result = await executeProbe({
        connection,
        model,
        prompt,
        signal: abort.signal,
      })
      if (current()) {
        this.publish({ probe: result })
        if (this.context.session.legacy)
          applyLegacy(this.context, await this.context.session.legacy.read())
      }
    } catch {
      if (current())
        this.publish({
          probe: {
            kind: "error",
            message:
              "The test request failed. Check gateway activity and try another model or refresh your account.",
          },
        })
    }
  }
  invoke = async (input: unknown): Promise<DesktopSnapshot> => {
    if (this.context.session.disposed) return this.snapshot()
    const command = commandSchema.safeParse(input)
    if (!command.success) {
      this.notice("The app received an invalid command.")
      return this.snapshot()
    }
    this.publish({ notice: null })
    try {
      await this.dispatch(command.data)
    } catch {
      this.notice("The action could not be completed. Try again.")
    }
    return this.snapshot()
  }
  private dispatch(command: DesktopCommand): Promise<void> {
    switch (command.kind) {
      case "copy":
      case "copy-config": {
        return this.handleClipboardCommand(command)
      }
      case "start-gateway":
      case "stop-gateway":
      case "rotate-key":
      case "run-probe": {
        return this.handleGatewayCommand(command)
      }
      case "save-settings":
      case "select-model":
      case "select-agent-model":
      case "inspect-agent-config":
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
    command: Extract<
      DesktopCommand,
      {
        kind: "copy" | "copy-config"
      }
    >,
  ): Promise<void> {
    switch (command.kind) {
      case "copy":
      case "copy-config": {
        const authorization = this.context.state.authorization
        const result = createClipboardText({
          command,
          connection: this.activeConnection(),
          models: this.context.state.models,
          agentConfigs: this.context.state.agentConfigs,
          deviceCode:
            authorization.kind === "awaiting" ? authorization.code : null,
        })
        if (result.kind === "error") this.notice(result.message)
        else await this.context.options.writeClipboard(result.text)
        return
      }
      default: {
        const exhaustive: never = command
        return exhaustive
      }
    }
  }
  private async handleGatewayCommand(
    command: Extract<
      DesktopCommand,
      {
        kind: "start-gateway" | "stop-gateway" | "rotate-key" | "run-probe"
      }
    >,
  ): Promise<void> {
    switch (command.kind) {
      case "start-gateway": {
        if (this.context.session.legacy) {
          await refresh(this.context)
          return
        }
        if (
          !this.context.account.credentials
          || this.context.state.account.kind !== "signed-in"
        )
          this.notice("Sign in to GitHub before starting the gateway.")
        else await setGatewayDesired(this.context, true)
        return
      }
      case "stop-gateway": {
        await setGatewayDesired(this.context, false)
        return
      }
      case "rotate-key": {
        await rotateKey(this.context)
        return
      }
      case "run-probe": {
        const model = this.getModel(command.modelId)
        if (model) this.own(this.runProbe(model, command.prompt))
        else
          this.publish({
            probe: {
              kind: "error",
              message:
                "Choose an available model before sending a test request.",
            },
          })
        return
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
          | "open-config-folder"
          | "configure-agent"
      }
    >,
  ): Promise<void> {
    switch (command.kind) {
      case "save-settings": {
        await this.saveSettings(() => command.settings)
        return
      }
      case "select-model": {
        if (!this.getModel(command.modelId)) {
          this.notice(
            "This model is no longer available. Refresh the model catalog.",
          )
          return
        }
        await this.saveSettings((current) => ({
          ...current,
          preferredModel: command.modelId,
        }))
        return
      }
      case "select-agent-model": {
        const model = this.getModel(command.modelId)
        if (!model || !supportsAgent(model, command.target)) {
          this.notice(
            "Choose an available model that supports this agent's API.",
          )
          return
        }
        await this.saveSettings((current) => ({
          ...current,
          agentModelChoices: {
            ...current.agentModelChoices,
            [command.target]: command.modelId,
          },
        }))
        return
      }
      case "inspect-agent-config": {
        await this.inspectConfigs()
        return
      }
      case "open-config-folder": {
        if (!this.context.options.openFolder) {
          this.notice(
            "Opening configuration folders is unavailable in this session.",
          )
          return
        }
        await this.context.options.openFolder(
          getAgentConfigFolder(command.target, this.context.homeDirectory),
        )
        return
      }
      case "configure-agent": {
        const connection = this.activeConnection()
        if (!connection) {
          this.notice("Start the proxy before configuring an agent.")
          return
        }
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
          this.notice(
            "Existing configuration values were preserved. Review the fields that point to another proxy.",
          )
        else if (result.kind === "invalid") this.notice(result.message)
        return
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
  ): Promise<void> {
    switch (command.kind) {
      case "sign-in": {
        beginSignIn(this.context)
        return
      }
      case "cancel-sign-in": {
        cancelAuthorization(this.context)
        return
      }
      case "open-device-page": {
        if (this.context.state.authorization.kind === "awaiting")
          await this.context.options.openExternal(DEVICE_PAGE)
        return
      }
      case "sign-out": {
        await signOut(this.context)
        return
      }
      case "refresh": {
        await refresh(this.context)
        return
      }
      case "clear-activity": {
        if (this.context.session.legacy)
          this.notice(
            "The CLI retains this activity history. Its totals are not available.",
          )
        else this.publish({ activity: [] })
        return
      }
      case "dismiss-notice": {
        return
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
      this.context.account.attempt?.abort.abort()
      this.context.account.attempt = undefined
      this.context.account.accountGeneration++
      this.context.account.refreshAbort?.abort()
      this.context.session.probeAbort?.abort()
      this.context.session.desiredGateway = false
      this.context.session.legacyUnsubscribe?.()
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
        this.context.session.reconciliation,
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
