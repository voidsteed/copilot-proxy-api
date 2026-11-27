import type { ControlResult, NativeIntent } from "../../src/lib/proxy-contracts"
import type { CommandOutcome, DesktopSettings } from "../shared/contracts"
import type { ControllerContext } from "./controller-session"

import { detachLegacy, refresh } from "./controller-account"
import {
  activateRuntime,
  convergeGateway,
  drainReplacement,
  isDisposed,
  queueSettings,
  setGatewayDesired,
} from "./controller-session"
import { persistSettings } from "./settings-store"
import { createServiceSnapshot } from "./snapshot"

const CLOSED_OUTCOME: CommandOutcome = {
  kind: "rejected",
  message: "The desktop controller is closed.",
}

function hasUnreachableLegacy(context: ControllerContext): boolean {
  return (
    context.session.legacy !== undefined
    && context.session.legacySnapshot?.status === "unreachable"
  )
}

export async function detachUnreachableLegacy(
  context: ControllerContext,
  options: { restoreAccount: boolean },
): Promise<boolean> {
  if (!context.session.legacy) return false
  if (!hasUnreachableLegacy(context))
    await refresh(context, { refreshQuota: false })
  if (hasUnreachableLegacy(context)) {
    await detachLegacy(context, options)
    return true
  }
  return false
}

export async function readOnlyLegacyResult(
  context: ControllerContext,
  intent: NativeIntent,
): Promise<ControlResult | null> {
  if (!context.session.legacy) return null
  switch (intent.kind) {
    case "ensure-running": {
      const detached = await detachUnreachableLegacy(context, {
        restoreAccount: intent.credential.kind === "native-saved-account",
      })
      if (detached) return null
      break
    }
    case "authorize":
    case "authorize-with-token": {
      const detached = await detachUnreachableLegacy(context, {
        restoreAccount: false,
      })
      if (detached) return null
      break
    }
    case "refresh": {
      await refresh(context)
      break
    }
    default: {
      break
    }
  }
  return { kind: "session-changed", snapshot: createServiceSnapshot(context) }
}

export type LegacyPortSwitchPrepared =
  | { kind: "done"; outcome: CommandOutcome }
  | { kind: "detach"; next: DesktopSettings }

export async function prepareLegacyPortSwitch(options: {
  context: ControllerContext
  displayedPrevious: DesktopSettings
  displayedNext: DesktopSettings
  isDisposing: () => boolean
  reject: (message: string) => CommandOutcome
}): Promise<LegacyPortSwitchPrepared> {
  const { context, displayedPrevious, displayedNext, isDisposing, reject } =
    options
  const previousRuntime = context.settingsStore.runtime()
  const baseOptions = previousRuntime?.options ?? context.session.runtime
  const previous = {
    ...displayedPrevious,
    port: baseOptions.port,
    accountType: baseOptions.accountType,
  }
  const next = {
    ...displayedNext,
    port: displayedNext.port,
    accountType: baseOptions.accountType,
  }
  const saved = await persistSettings({
    previous,
    next,
    applyLoginItem: context.options.applyLoginItem?.bind(context.options),
    save: (settings) =>
      context.settingsStore.save(
        settings,
        previousRuntime ?
          {
            ...previousRuntime,
            options: {
              ...previousRuntime.options,
              port: next.port,
              accountType: next.accountType,
            },
          }
        : previousRuntime,
        { preferManagedPort: true },
      ),
  })
  if (saved.kind !== "saved")
    return { kind: "done", outcome: reject(saved.message) }
  if (isDisposing()) return { kind: "done", outcome: CLOSED_OUTCOME }
  context.session.runtime = {
    ...context.session.runtime,
    port: next.port,
  }
  context.session.configurationRevision++
  context.publish({ settings: next })
  return { kind: "detach", next }
}

export async function completeLegacyPortSwitch(options: {
  context: ControllerContext
  next: DesktopSettings
}): Promise<CommandOutcome> {
  const { context, next } = options
  await detachLegacy(context, { restoreAccount: true })
  if (isDisposed(context)) return CLOSED_OUTCOME
  context.publish({ settings: next })
  if (context.state.account.kind === "signed-in")
    await setGatewayDesired(context, true)
  await context.inspectConfigs()
  return { kind: "ok" }
}

function persistedSettings(
  context: ControllerContext,
  settings: DesktopSettings,
): DesktopSettings {
  if (!context.session.legacy) return settings
  const options =
    context.settingsStore.runtime()?.options ?? context.session.runtime
  return { ...settings, port: options.port, accountType: options.accountType }
}

async function saveManagedSettings(options: {
  context: ControllerContext
  displayedPrevious: DesktopSettings
  displayedNext: DesktopSettings
  portChanged: boolean
  restart: boolean
  isDisposing: () => boolean
  reject: (message: string) => CommandOutcome
}): Promise<CommandOutcome> {
  const {
    context,
    displayedPrevious,
    displayedNext,
    portChanged,
    restart,
    isDisposing,
    reject,
  } = options
  const previousRuntime = context.settingsStore.runtime()
  const previous = persistedSettings(context, displayedPrevious)
  const next = persistedSettings(context, displayedNext)
  const saved = await persistSettings({
    previous,
    next,
    applyLoginItem: context.options.applyLoginItem?.bind(context.options),
    save: (settings) =>
      context.settingsStore.save(
        settings,
        previousRuntime && !context.session.legacy ?
          {
            ...previousRuntime,
            options: {
              ...previousRuntime.options,
              port: next.port,
              accountType: next.accountType,
            },
          }
        : previousRuntime,
        portChanged ? { preferManagedPort: true } : undefined,
      ),
  })
  if (saved.kind !== "saved") return reject(saved.message)
  if (isDisposing()) return CLOSED_OUTCOME
  if (restart && !(await drainReplacement(context))) {
    await persistSettings({
      previous: next,
      next: previous,
      applyLoginItem: context.options.applyLoginItem?.bind(context.options),
      save: (settings) => context.settingsStore.save(settings, previousRuntime),
    }).catch(() => undefined)
    return reject(
      "The gateway is still serving an agent request. Its running configuration was preserved.",
    )
  }
  if (isDisposed(context)) return CLOSED_OUTCOME
  context.publish({ settings: displayedNext })
  if (restart) {
    activateRuntime(context, {
      runtime: {
        ...context.session.runtime,
        port: next.port,
        accountType: next.accountType,
      },
      authentication: context.session.authentication,
    })
    if (next.accountType !== previous.accountType)
      await refresh(context, { allowLegacyDiscovery: false })
    await convergeGateway(context)
  }
  await context.inspectConfigs()
  return { kind: "ok" }
}

export async function saveControllerSettings(options: {
  context: ControllerContext
  change: (current: DesktopSettings) => DesktopSettings
  isDisposing: () => boolean
  reject: (message: string) => CommandOutcome
}): Promise<CommandOutcome> {
  const { context, change, isDisposing, reject } = options
  const prepared = await queueSettings<LegacyPortSwitchPrepared>(
    context,
    async () => {
      if (isDisposed(context)) return { kind: "done", outcome: CLOSED_OUTCOME }
      const displayedPrevious = context.state.settings
      const displayedNext = change(displayedPrevious)
      const portChanged = displayedNext.port !== displayedPrevious.port
      const accountTypeChanged =
        displayedNext.accountType !== displayedPrevious.accountType
      if (context.session.legacy && portChanged)
        return prepareLegacyPortSwitch({
          context,
          displayedPrevious,
          displayedNext,
          isDisposing,
          reject,
        })
      if (context.session.legacy && accountTypeChanged)
        return {
          kind: "done",
          outcome: reject(
            "The CLI gateway's runtime settings are managed in Terminal.",
          ),
        }
      return {
        kind: "done",
        outcome: await saveManagedSettings({
          context,
          displayedPrevious,
          displayedNext,
          portChanged,
          restart: portChanged || accountTypeChanged,
          isDisposing,
          reject,
        }),
      }
    },
  )
  if (prepared.kind === "detach")
    return completeLegacyPortSwitch({ context, next: prepared.next })
  return prepared.outcome
}
