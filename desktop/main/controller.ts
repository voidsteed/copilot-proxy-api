import { randomBytes } from "node:crypto"
import { z } from "zod"

import type { ModelsResponse } from "../../src/services/copilot/get-models"
import type {
  ControllerOptions,
  DesktopController,
  StoredCredentials,
} from "./types"

import {
  createAccountClient,
  fixtureOriginSchema,
  toDesktopModel,
} from "../engine/upstream"
import {
  commandSchema,
  type ActivityRecord,
  type DesktopCommand,
  type DesktopModel,
  type DesktopSettings,
  type DesktopSnapshot,
} from "../shared/contracts"
import { createClipboardText } from "./clipboard"
import { gatewayError, signInError } from "./failure-messages"
import { authorizeDevice, DEVICE_PAGE } from "./oauth"
import { executeProbe } from "./probe"
import { type ProxyProcess, startProxyProcess } from "./proxy-process"
import { createSettingsStore, persistSettings } from "./settings-store"
import { appendActivity, initialSnapshot } from "./snapshot"
const credentialsSchema = z
  .object({
    githubToken: z.string().min(1).max(16384),
    gatewayKey: z.string().min(32).max(256),
  })
  .strict()
function newGatewayKey(): string {
  return randomBytes(32).toString("base64url")
}
class Controller implements DesktopController {
  private readonly options: ControllerOptions
  private fixtureOrigin: string | undefined
  private settingsStore: ReturnType<typeof createSettingsStore>
  private state: DesktopSnapshot
  private catalog: ModelsResponse | undefined
  private credentials: StoredCredentials | null = null
  private disposed: boolean = false
  private accountGeneration: number = 0
  private accountAbort: AbortController | undefined
  private refreshAbort: AbortController | undefined
  private probeAbort: AbortController | undefined
  private desiredGateway: boolean = false
  private configurationRevision: number = 0
  private owned:
    | {
        process: ProxyProcess
        revision: number
      }
    | undefined
  private reconciliation: Promise<void> | undefined
  private storage: Promise<void> = Promise.resolve()
  private settingsWrites: Promise<void> = Promise.resolve()
  private disposal: Promise<void> | undefined
  private background: Set<Promise<void>> = new Set<Promise<void>>()
  private listeners: Set<(snapshot: DesktopSnapshot) => void> = new Set<
    (snapshot: DesktopSnapshot) => void
  >()
  constructor(
    options: ControllerOptions,
    settingsStore: ReturnType<typeof createSettingsStore>,
    loaded: Awaited<ReturnType<typeof settingsStore.load>>,
  ) {
    this.options = options
    this.settingsStore = settingsStore
    this.fixtureOrigin =
      this.options.fixtureOrigin === undefined ?
        undefined
      : fixtureOriginSchema.parse(this.options.fixtureOrigin)
    this.state = initialSnapshot({
      version: options.version,
      platform: options.platform,
      fixture: this.fixtureOrigin !== undefined,
      storageMode: options.vault.mode,
      settings: loaded.settings,
      recovered: loaded.recovered,
    })
  }
  snapshot = (): DesktopSnapshot => {
    return structuredClone(this.state)
  }
  private publish(patch: Partial<DesktopSnapshot>): void {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 }
    if (this.disposed) return
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot())
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
        if (!this.disposed)
          this.notice("The action could not be completed. Try again.")
      })
      .finally(() => this.background.delete(guarded))
    this.background.add(guarded)
  }
  private writeCredentials(task: () => Promise<void>): Promise<void> {
    const next = this.storage.then(task)
    this.storage = next.catch(() => undefined)
    return next
  }
  private invalidateAccount(): number {
    this.accountGeneration++
    this.accountAbort?.abort()
    this.refreshAbort?.abort()
    this.probeAbort?.abort()
    return this.accountGeneration
  }
  private isAccountCurrent(generation: number, signal?: AbortSignal): boolean {
    return (
      !this.disposed
      && !signal?.aborted
      && generation === this.accountGeneration
    )
  }

  private canRunGateway(revision = this.configurationRevision): boolean {
    return (
      this.desiredGateway
      && !this.disposed
      && this.state.account.kind === "signed-in"
      && revision === this.configurationRevision
    )
  }

  private recordActivity(process: ProxyProcess, record: ActivityRecord): void {
    if (
      this.disposed
      || !this.credentials
      || this.state.account.kind !== "signed-in"
      || this.owned?.process !== process
    )
      return
    this.publish(appendActivity(this.state, record))
  }

  private processExited(process: ProxyProcess, expected: boolean): void {
    if (expected || this.disposed || this.owned?.process !== process) return
    this.owned = undefined
    this.desiredGateway = false
    this.publish({
      gateway: {
        kind: "error",
        message:
          "The gateway exited unexpectedly. Start it again to reconnect.",
      },
      ...(this.state.probe.kind === "running" ?
        {
          probe: {
            kind: "error",
            message:
              "The gateway stopped before the test request finished. Start it again.",
          },
        }
      : {}),
    })
    this.probeAbort?.abort()
  }

  private async reconcile(): Promise<void> {
    while (true) {
      if (this.owned && !this.canRunGateway(this.owned.revision)) {
        const previous = this.owned
        this.publish({ gateway: { kind: "stopping" } })
        await previous.process.stop()
        if (this.owned === previous) this.owned = undefined
        this.publish({ gateway: { kind: "stopped" } })
        continue
      }
      if (!this.canRunGateway() || !this.credentials) return
      if (this.owned) return
      const revision = this.configurationRevision
      const generation = this.accountGeneration
      const credentials = this.credentials
      this.publish({ gateway: { kind: "starting" } })
      if (!this.canRunGateway(revision)) continue
      let process: ProxyProcess
      try {
        process = startProxyProcess({
          runtimePath: this.options.runtimePath,
          runtimeExecPath: this.options.runtimeExecPath,
          init: {
            kind: "init",
            githubToken: credentials.githubToken,
            gatewayKey: credentials.gatewayKey,
            port: this.state.settings.port,
            accountType: this.state.settings.accountType,
            fixtureOrigin: this.fixtureOrigin,
          },
          onActivity: (record) => {
            if (generation === this.accountGeneration)
              this.recordActivity(process, record)
          },
          onExit: (expected) => this.processExited(process, expected),
        })
        this.owned = { process, revision }
        await process.ready
        await this.applyCurrentCatalog(process, revision)
        if (this.canRunGateway(revision)) {
          this.publish({
            gateway: {
              kind: "running",
              url: `http://127.0.0.1:${this.state.settings.port}/v1`,
              startedAt: new Date().toISOString(),
            },
          })
          return
        }
      } catch (error) {
        if (!this.canRunGateway(revision)) continue
        this.desiredGateway = false
        const previous = this.owned
        if (previous) {
          await previous.process.stop()
          if (this.owned === previous) this.owned = undefined
        }
        this.publish({
          gateway: { kind: "error", message: gatewayError(error) },
        })
        return
      }
    }
  }
  private async applyCurrentCatalog(
    process: ProxyProcess,
    revision: number,
  ): Promise<void> {
    let catalog = this.catalog
    while (catalog && this.canRunGateway(revision)) {
      await process.updateModels(catalog)
      if (catalog === this.catalog) return
      catalog = this.catalog
    }
  }

  private convergeGateway(): Promise<void> {
    if (!this.reconciliation) {
      const task = Promise.resolve()
        .then(() => this.reconcile())
        .finally(() => {
          if (this.reconciliation !== task) return
          this.reconciliation = undefined
          const unsettled =
            this.owned ?
              !this.canRunGateway(this.owned.revision)
            : this.canRunGateway() && this.credentials !== null
          if (unsettled) return this.convergeGateway()
        })
      this.reconciliation = task
    }
    return this.reconciliation
  }
  private setGatewayDesired(running: boolean): Promise<void> {
    if (!running && this.desiredGateway) this.configurationRevision++
    this.desiredGateway = running
    if (!running) {
      this.probeAbort?.abort()
      if (this.state.probe.kind === "running")
        this.publish({ probe: { kind: "idle" } })
      if (!this.owned) this.publish({ gateway: { kind: "stopped" } })
    }
    if (
      this.owned
      && (!running || this.owned.revision !== this.configurationRevision)
    )
      this.own(this.owned.process.stop())
    return this.convergeGateway()
  }
  private async refresh(): Promise<void> {
    if (!this.credentials || this.state.account.kind !== "signed-in") return
    this.refreshAbort?.abort()
    const abort = new AbortController()
    this.refreshAbort = abort
    const generation = this.accountGeneration
    const client = createAccountClient({
      githubToken: this.credentials.githubToken,
      accountType: this.state.settings.accountType,
      fixtureOrigin: this.fixtureOrigin,
      signal: abort.signal,
    })
    const results = await Promise.allSettled([
      client
        .token()
        .then((token) => client.models(token.token))
        .then((models) =>
          this.synchronizeCatalog(models, generation, abort.signal),
        ),
      client.usage().then((usage) => {
        if (
          !this.isAccountCurrent(generation, abort.signal)
          || this.state.account.kind !== "signed-in"
        )
          return
        this.publish({
          usage,
          account: { ...this.state.account, plan: usage.plan },
        })
      }),
    ])
    if (!this.isAccountCurrent(generation, abort.signal)) return
    if (results.some((result) => result.status === "rejected")) {
      this.notice(
        "Some account data could not be refreshed. Last successful values are still shown.",
      )
    }
  }

  private async synchronizeCatalog(
    models: ModelsResponse,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    while (this.isAccountCurrent(generation, signal)) {
      const target = this.owned
      if (!target || !this.canRunGateway(target.revision)) break
      try {
        await target.process.updateModels(models)
      } catch (error) {
        if (this.owned === target && this.canRunGateway(target.revision)) {
          await this.setGatewayDesired(false)
          throw error
        }
        continue
      }
      if (this.owned === target) break
    }
    if (!this.isAccountCurrent(generation, signal)) return
    this.catalog = models
    this.publish({
      models: models.data
        .filter((model) => model.capabilities.type === "chat")
        .map((model) => toDesktopModel(model)),
      modelsFetchedAt: new Date().toISOString(),
    })
  }

  private async finishAuthentication(
    token: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    const client = createAccountClient({
      githubToken: token,
      accountType: this.state.settings.accountType,
      fixtureOrigin: this.fixtureOrigin,
      signal,
    })
    const user = await client.user()
    if (!this.isAccountCurrent(generation, signal)) return
    const next = {
      githubToken: token,
      gatewayKey: this.credentials?.gatewayKey ?? newGatewayKey(),
    }
    await this.writeCredentials(async () => {
      if (!this.isAccountCurrent(generation, signal)) return
      await this.options.vault.save(next)
      if (!this.isAccountCurrent(generation, signal))
        await this.options.vault.clear()
    })
    if (!this.isAccountCurrent(generation, signal)) return
    this.credentials = next
    this.configurationRevision++
    this.publish({
      account: {
        kind: "signed-in",
        login: user.login,
        name: user.name,
        plan: "Copilot",
      },
      notice: null,
    })
    await this.refresh()
    if (this.isAccountCurrent(generation, signal)) await this.convergeGateway()
  }
  private beginSignIn(): void {
    if (
      this.state.account.kind === "signed-in"
      || this.state.account.kind === "connecting"
      || this.state.account.kind === "awaiting-authorization"
    )
      return
    const generation = this.invalidateAccount()
    const abort = new AbortController()
    this.accountAbort = abort
    this.desiredGateway = this.state.settings.startOnLaunch
    this.publish({
      account: { kind: "connecting" },
      notice: null,
      probe: { kind: "idle" },
    })
    this.own(
      authorizeDevice({
        fixtureOrigin: this.fixtureOrigin,
        signal: abort.signal,
        onCode: (code) => {
          if (this.isAccountCurrent(generation, abort.signal)) {
            this.publish({
              account: { kind: "awaiting-authorization", ...code },
            })
          }
        },
      })
        .then((token) =>
          this.finishAuthentication(token, generation, abort.signal),
        )
        .catch((error: unknown) => {
          if (this.isAccountCurrent(generation, abort.signal)) {
            this.publish({
              account: { kind: "error", message: signInError(error) },
            })
          }
        }),
    )
  }
  private async signOut(): Promise<void> {
    this.invalidateAccount()
    this.credentials = null
    this.catalog = undefined
    this.configurationRevision++
    const clearing = this.writeCredentials(() => this.options.vault.clear())
    const stopping = this.setGatewayDesired(false)
    this.publish({
      account: { kind: "signed-out" },
      models: [],
      modelsFetchedAt: null,
      usage: null,
      probe: { kind: "idle" },
      activity: [],
      totals: {
        requests: 0,
        errors: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
      },
      notice: null,
    })
    await Promise.all([clearing, stopping])
  }
  private saveSettings(
    change: (current: DesktopSettings) => DesktopSettings,
  ): Promise<void> {
    const task = this.settingsWrites.then(async () => {
      if (this.disposed) return
      const previous = this.state.settings
      const next = change(previous)
      const saved = await persistSettings({
        previous,
        next,
        applyLoginItem: this.options.applyLoginItem?.bind(this.options),
        save: (settings) => this.settingsStore.save(settings),
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
      const restart =
        next.port !== previous.port || next.accountType !== previous.accountType
      const accountChanged = next.accountType !== previous.accountType
      if (accountChanged) {
        this.refreshAbort?.abort()
        this.catalog = undefined
      }
      this.publish({
        settings: next,
        ...(accountChanged ?
          { models: [], modelsFetchedAt: null, usage: null }
        : {}),
      })
      if (restart) {
        this.configurationRevision++
        this.probeAbort?.abort()
        if (this.state.probe.kind === "running")
          this.publish({ probe: { kind: "idle" } })
        if (this.owned) this.own(this.owned.process.stop())
        await this.convergeGateway()
      }
      if (accountChanged) await this.refresh()
    })
    this.settingsWrites = task.catch(() => undefined)
    return task
  }
  private getModel(id: string): DesktopModel | undefined {
    return this.state.models.find((model) => model.id === id)
  }
  private async runProbe(model: DesktopModel, prompt: string): Promise<void> {
    if (!this.credentials || this.state.gateway.kind !== "running") {
      this.publish({
        probe: {
          kind: "error",
          message: "Start the gateway before sending a test request.",
        },
      })
      return
    }
    this.probeAbort?.abort()
    const abort = new AbortController()
    this.probeAbort = abort
    const generation = this.accountGeneration
    const revision = this.configurationRevision
    const baseUrl = this.state.gateway.url
    const key = this.credentials.gatewayKey
    const current = () =>
      !this.disposed
      && !abort.signal.aborted
      && generation === this.accountGeneration
      && revision === this.configurationRevision
    this.publish({ probe: { kind: "running", model: model.id } })
    try {
      const result = await executeProbe({
        baseUrl,
        gatewayKey: key,
        model,
        prompt,
        signal: abort.signal,
      })
      if (current()) this.publish({ probe: result })
    } catch {
      if (!current()) return
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
    if (this.disposed) return this.snapshot()
    const parsed = commandSchema.safeParse(input)
    if (!parsed.success) {
      this.notice("The app received an invalid command.")
      return this.snapshot()
    }
    this.publish({ notice: null })
    try {
      await this.dispatch(parsed.data)
    } catch {
      this.notice("The action could not be completed. Try again.")
    }
    return this.snapshot()
  }

  private dispatch(command: DesktopCommand): void | Promise<void> {
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
      case "select-model": {
        return this.handleSettingsCommand(command)
      }
      default: {
        return this.handleAccountCommand(command)
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
        this.beginSignIn()
        return
      }
      case "cancel-sign-in": {
        if (
          this.state.account.kind === "connecting"
          || this.state.account.kind === "awaiting-authorization"
        ) {
          this.invalidateAccount()
          this.credentials = null
          this.desiredGateway = false
          this.publish({ account: { kind: "signed-out" } })
          this.own(this.writeCredentials(() => this.options.vault.clear()))
        }
        return
      }
      case "open-device-page": {
        if (this.state.account.kind === "awaiting-authorization")
          await this.options.openExternal(DEVICE_PAGE)
        return
      }
      case "sign-out": {
        await this.signOut()
        return
      }
      case "refresh": {
        await this.refresh()
        return
      }
      case "clear-activity": {
        this.publish({ activity: [] })
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

  private handleSettingsCommand(
    command: Extract<
      DesktopCommand,
      { kind: "save-settings" | "select-model" }
    >,
  ): void | Promise<void> {
    if (command.kind === "save-settings")
      return this.saveSettings(() => command.settings)
    if (!this.getModel(command.modelId)) {
      this.notice(
        "This model is no longer available. Refresh the model catalog.",
      )
      return
    }
    return this.saveSettings((current) => ({
      ...current,
      preferredModel: command.modelId,
    }))
  }

  private async handleGatewayCommand(
    command: Extract<
      DesktopCommand,
      { kind: "start-gateway" | "stop-gateway" | "rotate-key" | "run-probe" }
    >,
  ): Promise<void> {
    switch (command.kind) {
      case "start-gateway": {
        if (!this.credentials || this.state.account.kind !== "signed-in")
          this.notice("Sign in to GitHub before starting the gateway.")
        else await this.setGatewayDesired(true)
        return
      }
      case "stop-gateway": {
        await this.setGatewayDesired(false)
        return
      }
      case "rotate-key": {
        await this.rotateKey()
        return
      }
      case "run-probe": {
        const model = this.getModel(command.modelId)
        if (!model)
          this.publish({
            probe: {
              kind: "error",
              message:
                "Choose an available model before sending a test request.",
            },
          })
        else this.own(this.runProbe(model, command.prompt))
        return
      }
      default: {
        const exhaustive: never = command
        return exhaustive
      }
    }
  }

  private async rotateKey(): Promise<void> {
    if (!this.credentials) {
      this.notice("Sign in before changing the gateway key.")
      return
    }
    const generation = this.accountGeneration
    const next = { ...this.credentials, gatewayKey: newGatewayKey() }
    await this.writeCredentials(async () => {
      if (!this.disposed && generation === this.accountGeneration)
        await this.options.vault.save(next)
    })
    if (!this.isAccountCurrent(generation)) return
    this.credentials = next
    this.configurationRevision++
    this.probeAbort?.abort()
    if (this.state.probe.kind === "running")
      this.publish({ probe: { kind: "idle" } })
    if (this.owned) this.own(this.owned.process.stop())
    await this.convergeGateway()
    this.notice(
      "Gateway key changed. Copy fresh configurations for your agents.",
      "info",
    )
  }

  private async handleClipboardCommand(
    command: Extract<DesktopCommand, { kind: "copy" | "copy-config" }>,
  ): Promise<void> {
    const result = createClipboardText({
      command,
      port: this.state.settings.port,
      gatewayKey: this.credentials?.gatewayKey ?? null,
      deviceCode:
        this.state.account.kind === "awaiting-authorization" ?
          this.state.account.code
        : null,
      models: this.state.models,
    })
    if (result.kind === "error") this.notice(result.message)
    else await this.options.writeClipboard(result.text)
  }
  async restore(): Promise<void> {
    try {
      const stored = await this.options.vault.load()
      if (stored) {
        this.credentials = credentialsSchema.parse(stored)
        const generation = this.invalidateAccount()
        const abort = new AbortController()
        this.accountAbort = abort
        this.desiredGateway = this.state.settings.startOnLaunch
        this.publish({ account: { kind: "connecting" } })
        this.own(
          this.finishAuthentication(
            this.credentials.githubToken,
            generation,
            abort.signal,
          ).catch((error: unknown) => {
            if (this.isAccountCurrent(generation, abort.signal)) {
              this.credentials = null
              this.publish({
                account: { kind: "error", message: signInError(error) },
              })
            }
          }),
        )
      }
    } catch {
      this.credentials = null
      this.notice("Saved credentials could not be restored. Sign in again.")
    }
  }
  subscribe = (listener: (snapshot: DesktopSnapshot) => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  dispose = (): Promise<void> => {
    this.disposal ??= (async () => {
      this.disposed = true
      this.invalidateAccount()
      this.listeners.clear()
      await this.setGatewayDesired(false)
      await Promise.allSettled([
        ...this.background,
        this.settingsWrites,
        this.storage,
      ])
      this.credentials = null
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
  const loaded = await settingsStore.load()
  const controller = new Controller(options, settingsStore, loaded)
  await controller.restore()
  return controller
}
