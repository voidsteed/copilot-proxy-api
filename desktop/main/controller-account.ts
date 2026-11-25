import { randomUUID } from "node:crypto"

import type {
  NativeIntent,
  RuntimeOptions,
  RuntimeOverrides,
} from "../../src/lib/proxy-contracts"
import type { ModelsResponse } from "../../src/services/copilot/get-models"
import type { CommandOutcome } from "../shared/contracts"
import type {
  ControllerContext,
  GatewayCreationReceipt,
  NativeOperationResult,
  RefreshOptions,
} from "./controller-session"
import type { StoredCredentials } from "./types"

import {
  authorizationIdSchema,
  runtimeOptionsSchema,
} from "../../src/lib/proxy-contracts"
import { writeNativeCredentialProvenance } from "../../src/lib/proxy-session"
import { createAccountClient, toDesktopModel } from "../engine/upstream"
import {
  applyLegacy,
  applyRuntime,
  canRunGateway,
  convergeGateway,
  detachLegacySession,
  discoverLegacy,
  drainReplacement,
  isDisposed,
  persistRuntime,
  queueSettings,
  setGatewayDesired,
  unsupportedRuntime,
} from "./controller-session"
import { signInError } from "./failure-messages"
import { authorizeDevice } from "./oauth"
import { newGatewayKey, runBestEffort } from "./settings-store"
import {
  type AuthorizationAttempt,
  clearAttempt,
  createServiceSnapshot,
  emptyTotals,
  evaluateRefreshOutcome,
  isAccountCurrent,
  isAuthorizationCurrent,
  loadSavedCredentials,
  restoreSavedAccount,
  writeCredentials,
} from "./snapshot"

export {
  type ControllerAccountState,
  createControllerAccountState,
  isAccountCurrent,
  isAuthorizationCurrent,
  writeCredentials,
} from "./snapshot"
function rejectAccount(
  context: ControllerContext,
  message: string,
): CommandOutcome {
  context.notice(message)
  return { kind: "rejected", message }
}
export async function synchronizeCatalog(
  context: ControllerContext,
  models: ModelsResponse,
  options: { generation: number; signal: AbortSignal },
): Promise<{ catalogSyncFailed: boolean }> {
  const { generation, signal } = options
  let catalogSyncFailed = false
  while (isAccountCurrent(context, generation, signal)) {
    const target = context.session.owned
    if (!target || !canRunGateway(context, target.revision)) break
    try {
      await target.process.updateModels(models)
      catalogSyncFailed = false
    } catch {
      if (
        context.session.owned === target
        && canRunGateway(context, target.revision)
      ) {
        catalogSyncFailed = true
        break
      }
      continue
    }
    if (context.session.owned === target) break
  }
  if (!isAccountCurrent(context, generation, signal))
    return { catalogSyncFailed: false }
  context.account.catalog = models
  context.publish({
    models: models.data.map((model) => toDesktopModel(model)),
    modelsFetchedAt: new Date().toISOString(),
  })
  await context.inspectConfigs()
  return { catalogSyncFailed }
}
async function retryRestoredAccount(
  context: ControllerContext,
  githubToken: string,
): Promise<CommandOutcome> {
  const attempt = newAuthorization(context)
  context.publish({ authorization: { kind: "validating", id: attempt.id } })
  try {
    await finishAuthentication(context, {
      token: githubToken,
      attempt,
      persistence: "restored",
    })
    return { kind: "ok" }
  } catch (error) {
    authorizationFailed(context, attempt, error)
    return { kind: "rejected", message: signInError(error) }
  } finally {
    clearAttempt(context, attempt)
  }
}
export async function refresh(
  context: ControllerContext,
  options: RefreshOptions = {},
): Promise<CommandOutcome> {
  const allowLegacyDiscovery = options.allowLegacyDiscovery ?? true
  const refreshQuota = options.refreshQuota ?? true
  if (allowLegacyDiscovery && !context.session.owned && !context.session.legacy)
    await discoverLegacy(context)
  if (context.session.legacy) {
    applyLegacy(context, await context.session.legacy.read({ refreshQuota }))
    await context.inspectConfigs()
    return { kind: "ok" }
  }
  if (
    !context.account.credentials
    || context.state.account.kind !== "signed-in"
  ) {
    if (
      context.account.credentials
      && context.state.account.kind === "error"
      && !context.account.attempt
    )
      return retryRestoredAccount(
        context,
        context.account.credentials.githubToken,
      )
    await context.inspectConfigs()
    return { kind: "ok" }
  }
  context.account.refreshAbort?.abort()
  const abort = new AbortController()
  context.account.refreshAbort = abort
  const generation = context.account.accountGeneration
  const client = createAccountClient({
    githubToken: context.account.credentials.githubToken,
    accountType: context.session.runtime.accountType,
    fixtureOrigin: context.fixtureOrigin,
    signal: abort.signal,
  })
  const results = await Promise.allSettled([
    client
      .token()
      .then((token) => client.models(token.token))
      .then((models) =>
        synchronizeCatalog(context, models, {
          generation,
          signal: abort.signal,
        }),
      ),
    client.usage().then((usage) => {
      if (
        isAccountCurrent(context, generation, abort.signal)
        && context.state.account.kind === "signed-in"
      )
        context.publish({
          usage,
          account: { ...context.state.account, plan: usage.plan },
        })
    }),
  ])
  if (!isAccountCurrent(context, generation, abort.signal))
    return { kind: "ok" }
  return evaluateRefreshOutcome(context, results)
}
export function authorizationFailed(
  context: ControllerContext,
  attempt: AuthorizationAttempt,
  error: unknown,
): void {
  if (!isAuthorizationCurrent(context, attempt)) return
  context.account.attempt = undefined
  const message = signInError(error)
  context.publish({
    authorization: { kind: "error", id: attempt.id, message },
    ...(context.state.account.kind === "signed-in" ?
      { notice: { kind: "error", message } }
    : { account: { kind: "error", message } }),
  })
}
type AuthenticationOptions = {
  token: string
  attempt: AuthorizationAttempt
  persistence: "vault" | "session" | "restored"
  runtime?: RuntimeOptions
  authentication?: NonNullable<RuntimeOverrides["authentication"]>
}
type AuthenticatedAccount = AuthenticationOptions & {
  credentials: StoredCredentials
  runtime: RuntimeOptions
  user: Awaited<ReturnType<ReturnType<typeof createAccountClient>["user"]>>
  catalog: ModelsResponse
  usage: ControllerContext["state"]["usage"]
  runtimeWasExplicit: boolean
}
function accountAuthentication(
  context: ControllerContext,
  account: AuthenticatedAccount,
): NonNullable<RuntimeOverrides["authentication"]> {
  if (account.authentication) return account.authentication
  if (context.settingsStore.runtime()?.authentication.kind === "none")
    return { kind: "none" }
  return context.session.authentication.kind === "keyed" ?
      context.session.authentication
    : { kind: "keyed", keys: [account.credentials.gatewayKey] }
}
function ensureAuthorizationCurrent(
  context: ControllerContext,
  attempt: AuthorizationAttempt,
): void {
  if (!isAuthorizationCurrent(context, attempt))
    throw new Error("Authorization was canceled.")
}
function activateAccount(
  context: ControllerContext,
  account: AuthenticatedAccount,
): void {
  const previous = context.account.credentials
  const authentication = accountAuthentication(context, account)
  const tokenChanged = previous?.githubToken !== account.credentials.githubToken
  const runtimeChanged =
    tokenChanged
    || JSON.stringify(context.session.runtime)
      !== JSON.stringify(account.runtime)
    || JSON.stringify(context.session.authentication)
      !== JSON.stringify(authentication)
  context.account.credentials = account.credentials
  context.account.credentialSource =
    account.persistence === "session" ? "session-override" : "native-vault"
  if (account.persistence !== "session")
    context.account.savedCredentials = account.credentials
  context.session.authentication = authentication
  context.session.runtime = account.runtime
  if (tokenChanged) context.account.accountGeneration++
  if (runtimeChanged) context.session.configurationRevision++
  context.account.catalog = account.catalog
  context.account.refreshAbort?.abort()
  context.account.attempt = undefined
  context.publish({
    account: {
      kind: "signed-in",
      login: account.user.login,
      name: account.user.name,
      plan: account.usage?.plan ?? "Copilot",
    },
    authorization: { kind: "idle" },
    settings: {
      ...context.state.settings,
      port: account.runtime.port,
      accountType: account.runtime.accountType,
    },
    models: account.catalog.data.map((model) => toDesktopModel(model)),
    modelsFetchedAt: new Date().toISOString(),
    usage: account.usage,
    notice: null,
    ...(previous && previous.githubToken !== account.credentials.githubToken ?
      { activity: [], totals: emptyTotals(), probe: { kind: "idle" } }
    : {}),
  })
}
function accountRuntimeChanged(
  context: ControllerContext,
  account: AuthenticatedAccount,
): boolean {
  return (
    context.account.credentials?.githubToken !== account.token
    || JSON.stringify(account.runtime)
      !== JSON.stringify(context.session.runtime)
    || JSON.stringify(account.authentication)
      !== JSON.stringify(context.session.authentication)
  )
}
async function drainBeforeAccountChange(
  context: ControllerContext,
  account: AuthenticatedAccount,
): Promise<boolean> {
  const target = context.session.owned
  const stopping =
    context.state.gateway.kind === "stopping"
    || (!context.session.desiredGateway
      && context.session.reconciliation !== undefined)
  if (!target || !accountRuntimeChanged(context, account) || stopping)
    return false
  const drained = await drainReplacement(context, target, {
    current: () => isAuthorizationCurrent(context, account.attempt),
  })
  if (!drained)
    throw new Error("The gateway is still serving an agent request.")
  return true
}
async function replaceAuthorizedAccount(
  context: ControllerContext,
  incoming: AuthenticatedAccount,
): Promise<void> {
  ensureAuthorizationCurrent(context, incoming.attempt)
  let saved = false
  let runtimeSaved = false
  let stoppedGateway = false
  const previousSettings = context.state.settings
  const previousRuntime = context.settingsStore.runtime()
  const account = {
    ...incoming,
    runtime:
      incoming.runtimeWasExplicit ? incoming.runtime : context.session.runtime,
    authentication: accountAuthentication(context, incoming),
  }
  try {
    if (account.persistence === "vault") {
      await context.options.vault.save(account.credentials)
      saved = true
    }
    ensureAuthorizationCurrent(context, account.attempt)
    if (account.persistence !== "session") {
      await persistRuntime(context, {
        runtime: account.runtime,
        authentication: accountAuthentication(context, account),
      })
      runtimeSaved = true
    }
    stoppedGateway = await drainBeforeAccountChange(context, account)
    ensureAuthorizationCurrent(context, account.attempt)
    if (account.persistence !== "session")
      await writeNativeCredentialProvenance({
        stateDirectory: context.stateDirectory,
        provenance: { kind: "native-authority", account: "saved" },
      })
    ensureAuthorizationCurrent(context, account.attempt)
    activateAccount(context, account)
  } catch (error) {
    if (runtimeSaved)
      await runBestEffort(() =>
        context.settingsStore.save(previousSettings, previousRuntime),
      )
    if (saved) await runBestEffort(() => restoreSavedAccount(context))
    if (stoppedGateway && canRunGateway(context) && !context.session.owned)
      await runBestEffort(() =>
        convergeGateway(context, { claimCreation: false }).then(
          () => undefined,
        ),
      )
    throw error
  }
}
export async function finishAuthentication(
  context: ControllerContext,
  options: AuthenticationOptions,
): Promise<GatewayCreationReceipt> {
  const runtime = options.runtime ?? context.session.runtime
  const client = createAccountClient({
    githubToken: options.token,
    accountType: runtime.accountType,
    fixtureOrigin: context.fixtureOrigin,
    signal: options.attempt.abort.signal,
  })
  const user = await client.user()
  ensureAuthorizationCurrent(context, options.attempt)
  context.publish({
    authorization: { kind: "validating", id: options.attempt.id },
  })
  const copilotToken = await client.token()
  const catalog = await client.models(copilotToken.token)
  ensureAuthorizationCurrent(context, options.attempt)
  const usage = await client.usage().catch(() => null)
  const account: AuthenticatedAccount = {
    ...options,
    runtime,
    user,
    catalog,
    usage,
    runtimeWasExplicit: options.runtime !== undefined,
    credentials: {
      githubToken: options.token,
      gatewayKey: context.account.credentials?.gatewayKey ?? newGatewayKey(),
    },
  }
  return writeCredentials(context, () =>
    queueSettings(context, async () => {
      await replaceAuthorizedAccount(context, account)
      if (
        !isDisposed(context)
        && context.account.credentials?.githubToken === options.token
        && context.state.account.kind === "signed-in"
      ) {
        await context.inspectConfigs()
        return convergeGateway(context)
      }
      return null
    }),
  )
}
export function newAuthorization(
  context: ControllerContext,
  options: { preserveDesiredGateway?: boolean } = {},
): AuthorizationAttempt {
  context.account.attempt?.abort.abort()
  const attempt = {
    id: authorizationIdSchema.parse(randomUUID()),
    abort: new AbortController(),
  }
  context.account.attempt = attempt
  if (
    !options.preserveDesiredGateway
    && context.state.account.kind !== "signed-in"
  )
    context.session.desiredGateway = context.state.settings.startOnLaunch
  context.publish({
    authorization: { kind: "connecting", id: attempt.id },
    notice: null,
    ...(context.state.account.kind !== "signed-in" ?
      { account: { kind: "connecting" } }
    : {}),
  })
  return attempt
}
export function beginSignIn(context: ControllerContext): CommandOutcome {
  if (context.session.legacy)
    return rejectAccount(
      context,
      "The CLI gateway's account is managed in Terminal.",
    )
  if (context.account.attempt && context.state.authorization.kind !== "error")
    return { kind: "ok" }
  const attempt = newAuthorization(context)
  context.own(
    authorizeDevice({
      fixtureOrigin: context.fixtureOrigin,
      signal: attempt.abort.signal,
      onCode: (code) => {
        if (!isAuthorizationCurrent(context, attempt)) return
        context.publish({
          authorization: { kind: "awaiting", id: attempt.id, ...code },
          ...(context.state.account.kind === "signed-in" ?
            {}
          : { account: { kind: "awaiting-authorization", ...code } }),
        })
      },
    })
      .then((token) =>
        finishAuthentication(context, { token, attempt, persistence: "vault" }),
      )
      .then(() => undefined)
      .catch((error: unknown) => authorizationFailed(context, attempt, error))
      .finally(() => clearAttempt(context, attempt)),
  )
  return { kind: "ok" }
}
export function cancelAuthorization(context: ControllerContext): void {
  if (!context.account.attempt) return
  context.account.attempt.abort.abort()
  context.account.attempt = undefined
  context.publish({
    authorization: { kind: "idle" },
    ...(context.state.account.kind === "signed-in" || context.session.legacy ?
      {}
    : { account: { kind: "signed-out" } }),
  })
}
export async function signOut(
  context: ControllerContext,
): Promise<CommandOutcome> {
  if (context.session.legacy)
    return rejectAccount(
      context,
      "The CLI gateway's account is managed in Terminal.",
    )
  cancelAuthorization(context)
  const generation = ++context.account.accountGeneration
  context.account.refreshAbort?.abort()
  context.session.probeAbort?.abort()
  context.account.credentials = null
  context.account.savedCredentials = null
  context.account.credentialSource = "native-vault"
  context.account.catalog = undefined
  context.session.authentication = { kind: "none" }
  context.session.configurationRevision++
  const clearing = writeCredentials(context, async () => {
    await context.options.vault.clear()
    await writeNativeCredentialProvenance({
      stateDirectory: context.stateDirectory,
      provenance: { kind: "native-authority", account: "signed-out" },
    })
  })
  const clearingRuntime = queueSettings(context, async () => {
    if (!isAccountCurrent(context, generation)) return
    const stored = context.settingsStore.runtime()
    if (stored?.encryptedAuthentication)
      await context.settingsStore.save(context.state.settings, {
        ...stored,
        encryptedAuthentication: null,
      })
  })
  const stopping = setGatewayDesired(context, false)
  context.publish({
    account: { kind: "signed-out" },
    authorization: { kind: "idle" },
    lastConfigureResult: null,
    models: [],
    modelsFetchedAt: null,
    usage: null,
    probe: { kind: "idle" },
    activity: [],
    totals: emptyTotals(),
    notice: null,
  })
  await Promise.all([clearing, clearingRuntime, stopping])
  if (!isDisposed(context)) await context.inspectConfigs()
  return { kind: "ok" }
}
async function replaceGatewayKey(
  context: ControllerContext,
  options: { next: StoredCredentials; generation: number },
): Promise<void> {
  if (!isAccountCurrent(context, options.generation)) return
  const previousSettings = context.state.settings
  const previousRuntime = context.settingsStore.runtime()
  let credentialsSaved = false
  let runtimeSaved = false
  let stoppedGateway = false
  try {
    if (context.account.credentialSource === "native-vault") {
      await context.options.vault.save(options.next)
      credentialsSaved = true
      await persistRuntime(context, {
        runtime: context.session.runtime,
        authentication: { kind: "keyed", keys: [options.next.gatewayKey] },
      })
      runtimeSaved = true
    }
    if (context.session.owned) {
      if (!(await drainReplacement(context)))
        throw new Error(
          "The gateway is still serving an agent request. Its running configuration was preserved.",
        )
      stoppedGateway = true
    }
    if (!isAccountCurrent(context, options.generation))
      throw new Error("The account changed before the gateway key was applied.")
    context.account.credentials = options.next
    if (context.account.credentialSource === "native-vault")
      context.account.savedCredentials = options.next
    context.session.authentication = {
      kind: "keyed",
      keys: [options.next.gatewayKey],
    }
    context.session.configurationRevision++
  } catch (error) {
    if (runtimeSaved && isAccountCurrent(context, options.generation))
      await runBestEffort(() =>
        context.settingsStore.save(previousSettings, previousRuntime),
      )
    if (credentialsSaved && isAccountCurrent(context, options.generation))
      await runBestEffort(() => restoreSavedAccount(context))
    if (stoppedGateway && canRunGateway(context) && !context.session.owned)
      await runBestEffort(() =>
        convergeGateway(context, { claimCreation: false }).then(
          () => undefined,
        ),
      )
    throw error
  }
}
export async function rotateKey(
  context: ControllerContext,
): Promise<CommandOutcome> {
  if (context.session.legacy)
    return rejectAccount(
      context,
      "The CLI gateway's authentication is managed in Terminal.",
    )
  if (!context.account.credentials)
    return rejectAccount(context, "Sign in before changing the gateway key.")
  const next = { ...context.account.credentials, gatewayKey: newGatewayKey() }
  const generation = context.account.accountGeneration
  try {
    await writeCredentials(context, () =>
      queueSettings(context, () =>
        replaceGatewayKey(context, { next, generation }),
      ),
    )
  } catch (error) {
    return rejectAccount(
      context,
      error instanceof Error && error.message.trim().length > 0 ?
        error.message
      : "The gateway key could not be changed. Try again.",
    )
  }
  await convergeGateway(context)
  await context.inspectConfigs()
  if (context.account.credentials === next) {
    const message = "Gateway key changed. Review your agent configurations."
    context.notice(message, "info")
    return { kind: "ok", message }
  }
  return { kind: "ok" }
}
export async function detachLegacy(
  context: ControllerContext,
  options: { restoreAccount?: boolean } = {},
): Promise<CommandOutcome> {
  if (!(await detachLegacySession(context))) return { kind: "ok" }
  const restoreAccount = options.restoreAccount ?? true
  if (restoreAccount && !context.account.credentials)
    await loadSavedCredentials(context)
  if (restoreAccount && context.account.credentials && !isDisposed(context)) {
    const attempt = newAuthorization(context, { preserveDesiredGateway: true })
    context.session.desiredGateway = false
    context.publish({ authorization: { kind: "validating", id: attempt.id } })
    try {
      await finishAuthentication(context, {
        token: context.account.credentials.githubToken,
        attempt,
        persistence: "restored",
      })
    } catch (error) {
      authorizationFailed(context, attempt, error)
    } finally {
      clearAttempt(context, attempt)
    }
  }
  if (!isDisposed(context)) await context.inspectConfigs()
  return { kind: "ok" }
}
export async function restore(context: ControllerContext): Promise<void> {
  const attempted = new Set<string>()
  if (await discoverLegacy(context, { attempted })) return
  await loadSavedCredentials(context)
  await context.inspectConfigs()
  if (!context.account.credentials) return
  if (await discoverLegacy(context, { attempted })) return
  const attempt = newAuthorization(context)
  context.publish({ authorization: { kind: "validating", id: attempt.id } })
  const task = finishAuthentication(context, {
    token: context.account.credentials.githubToken,
    attempt,
    persistence: "restored",
  })
    .then(() => undefined)
    .catch((error: unknown) => authorizationFailed(context, attempt, error))
    .finally(() => clearAttempt(context, attempt))
  context.account.restoring = task.finally(() => {
    context.account.restoring = undefined
  })
  context.own(context.account.restoring)
}
export async function authorizeSessionAccount(
  context: ControllerContext,
  options: {
    token: string
    runtime?: RuntimeOptions
    authentication?: NonNullable<RuntimeOverrides["authentication"]>
  },
): Promise<GatewayCreationReceipt> {
  const attempt = newAuthorization(context)
  try {
    return await finishAuthentication(context, {
      ...options,
      attempt,
      persistence: "session",
    })
  } catch (error) {
    authorizationFailed(context, attempt, error)
    throw error
  } finally {
    clearAttempt(context, attempt)
  }
}
export async function authorizeNativeAccount(
  context: ControllerContext,
  intent: Extract<
    NativeIntent,
    { kind: "authorize" | "cancel-authorization" | "authorize-with-token" }
  >,
): Promise<NativeOperationResult | null> {
  switch (intent.kind) {
    case "authorize": {
      beginSignIn(context)
      return null
    }
    case "cancel-authorization": {
      if (context.account.attempt?.id !== intent.authorizationId)
        return {
          kind: "session-changed",
          snapshot: createServiceSnapshot(context),
        }
      cancelAuthorization(context)
      return null
    }
    case "authorize-with-token": {
      return {
        kind: "applied",
        createdGateway: await authorizeSessionAccount(context, {
          token: intent.token,
        }),
      }
    }
    default: {
      const exhaustive: never = intent
      return exhaustive
    }
  }
}
export async function ensureNativeAccount(
  context: ControllerContext,
  intent: Extract<NativeIntent, { kind: "ensure-running" }>,
): Promise<NativeOperationResult | null> {
  const unsupported = unsupportedRuntime(intent.explicit)
  if (unsupported) return unsupported
  if (context.account.restoring) await context.account.restoring
  let createdGateway: GatewayCreationReceipt = null
  if (intent.credential.kind === "provided-token") {
    const { authentication, ...options } = intent.explicit
    createdGateway = await authorizeSessionAccount(context, {
      token: intent.credential.value,
      authentication,
      runtime: runtimeOptionsSchema.parse({
        ...context.session.runtime,
        ...options,
      }),
    })
  } else if (
    !context.account.credentials
    || context.state.account.kind !== "signed-in"
  )
    return {
      kind: "unavailable",
      message:
        "Sign in to GitHub in Copilot Proxy before starting a shared gateway.",
    }
  const runtime = await applyRuntime(context, intent.explicit)
  if (runtime.kind === "preserved")
    return {
      kind: "unavailable",
      message:
        "The running gateway is still serving an agent request. Its configuration was preserved.",
    }
  createdGateway = runtime.createdGateway ?? createdGateway
  createdGateway =
    (await queueSettings(context, () => setGatewayDesired(context, true)))
    ?? createdGateway
  if (context.session.legacySnapshot)
    return { kind: "session-changed", snapshot: createServiceSnapshot(context) }
  if (context.state.gateway.kind !== "running")
    return {
      kind: "unavailable",
      message:
        context.state.gateway.kind === "error" ?
          context.state.gateway.message
        : "The gateway did not start.",
    }
  return { kind: "applied", createdGateway }
}
