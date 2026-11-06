import { randomBytes, randomUUID } from "node:crypto"
import { z } from "zod"

import type {
  NativeIntent,
  RuntimeOptions,
  RuntimeOverrides,
} from "../../src/lib/proxy-contracts"
import type { ModelsResponse } from "../../src/services/copilot/get-models"
import type {
  ControllerContext,
  GatewayCreationReceipt,
  NativeOperationResult,
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
  discoverLegacy,
  canRunGateway,
  drainReplacement,
  convergeGateway,
  setGatewayDesired,
  applyRuntime,
  persistRuntime,
  queueSettings,
  unsupportedRuntime,
} from "./controller-session"
import { signInError } from "./failure-messages"
import { authorizeDevice } from "./oauth"
import { createServiceSnapshot } from "./snapshot"
const credentialsSchema = z
  .object({
    githubToken: z.string().min(1).max(16384),
    gatewayKey: z.string().min(1).max(4096),
  })
  .strict()
const emptyTotals = () => ({
  requests: 0,
  errors: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
})
function newGatewayKey(): string {
  return randomBytes(32).toString("base64url")
}
type AuthorizationAttempt = {
  id: ReturnType<typeof authorizationIdSchema.parse>
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
export async function synchronizeCatalog(
  context: ControllerContext,
  models: ModelsResponse,
  options: { generation: number; signal: AbortSignal },
): Promise<void> {
  const { generation, signal } = options
  while (isAccountCurrent(context, generation, signal)) {
    const target = context.session.owned
    if (!target || !canRunGateway(context, target.revision)) break
    try {
      await target.process.updateModels(models)
    } catch (error) {
      if (
        context.session.owned === target
        && canRunGateway(context, target.revision)
      ) {
        await setGatewayDesired(context, false)
        throw error
      }
      continue
    }
    if (context.session.owned === target) break
  }
  if (!isAccountCurrent(context, generation, signal)) return
  context.account.catalog = models
  context.publish({
    models: models.data.map((model) => toDesktopModel(model)),
    modelsFetchedAt: new Date().toISOString(),
  })
  await context.inspectConfigs()
}
export async function refresh(context: ControllerContext): Promise<void> {
  if (!context.session.owned && !context.session.legacy)
    await discoverLegacy(context)
  if (context.session.legacy) {
    applyLegacy(context, await context.session.legacy.read())
    await context.inspectConfigs()
    return
  }
  if (
    !context.account.credentials
    || context.state.account.kind !== "signed-in"
  ) {
    await context.inspectConfigs()
    return
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
  if (
    isAccountCurrent(context, generation, abort.signal)
    && results.some((result) => result.status === "rejected")
  )
    context.notice(
      "Some account data could not be refreshed. Last successful values are still shown.",
    )
}
export function authorizationFailed(
  context: ControllerContext,
  attempt: AuthorizationAttempt,
  error: unknown,
): void {
  if (!isAuthorizationCurrent(context, attempt)) return
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
async function restoreSavedAccount(context: ControllerContext): Promise<void> {
  await (context.account.savedCredentials ?
    context.options.vault.save(context.account.savedCredentials)
  : context.options.vault.clear())
}
async function replaceAuthorizedAccount(
  context: ControllerContext,
  incoming: AuthenticatedAccount,
): Promise<void> {
  ensureAuthorizationCurrent(context, incoming.attempt)
  let saved = false
  let runtimeSaved = false
  const previousSettings = context.state.settings
  const previousRuntime = context.settingsStore.runtime()
  const runtime =
    incoming.runtimeWasExplicit ? incoming.runtime : context.session.runtime
  const account = {
    ...incoming,
    runtime,
    authentication: accountAuthentication(context, incoming),
  }
  try {
    if (account.persistence === "vault") {
      await context.options.vault.save(account.credentials)
      saved = true
    }
    ensureAuthorizationCurrent(context, account.attempt)
    await persistRuntime(context, {
      runtime: account.runtime,
      authentication: accountAuthentication(context, account),
    })
    runtimeSaved = true
    const target = context.session.owned
    const changed =
      context.account.credentials?.githubToken !== account.token
      || JSON.stringify(account.runtime)
        !== JSON.stringify(context.session.runtime)
      || JSON.stringify(account.authentication)
        !== JSON.stringify(context.session.authentication)
    if (
      target
      && changed
      && context.state.gateway.kind !== "stopping"
      && !(await drainReplacement(context, target, {
        current: () => isAuthorizationCurrent(context, account.attempt),
      }))
    )
      throw new Error("The gateway is still serving an agent request.")
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
      await context.settingsStore.save(previousSettings, previousRuntime)
    if (saved) await restoreSavedAccount(context)
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
        !context.session.disposed
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
): AuthorizationAttempt {
  context.account.attempt?.abort.abort()
  const attempt = {
    id: authorizationIdSchema.parse(randomUUID()),
    abort: new AbortController(),
  }
  context.account.attempt = attempt
  if (context.state.account.kind !== "signed-in")
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
export function beginSignIn(context: ControllerContext): void {
  if (context.session.legacy) {
    context.notice("The CLI gateway's account is managed in Terminal.")
    return
  }
  if (context.account.attempt && context.state.authorization.kind !== "error")
    return
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
        finishAuthentication(context, {
          token: token,
          attempt: attempt,
          persistence: "vault",
        }),
      )
      .then(() => undefined)
      .catch((error: unknown) => authorizationFailed(context, attempt, error)),
  )
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
export async function signOut(context: ControllerContext): Promise<void> {
  if (context.session.legacy) {
    context.notice("The CLI gateway's account is managed in Terminal.")
    return
  }
  cancelAuthorization(context)
  context.account.accountGeneration++
  context.account.refreshAbort?.abort()
  context.session.probeAbort?.abort()
  context.account.credentials = null
  context.account.savedCredentials = null
  context.account.catalog = undefined
  context.session.configurationRevision++
  const clearing = writeCredentials(context, async () => {
    await context.options.vault.clear()
    await writeNativeCredentialProvenance({
      stateDirectory: context.stateDirectory,
      provenance: { kind: "native-authority", account: "signed-out" },
    })
  })
  const stopping = setGatewayDesired(context, false)
  context.publish({
    account: { kind: "signed-out" },
    authorization: { kind: "idle" },
    models: [],
    modelsFetchedAt: null,
    usage: null,
    probe: { kind: "idle" },
    activity: [],
    totals: emptyTotals(),
    notice: null,
  })
  await Promise.all([clearing, stopping])
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
  try {
    if (context.account.credentialSource === "native-vault") {
      await context.options.vault.save(options.next)
      credentialsSaved = true
    }
    await persistRuntime(context, {
      runtime: context.session.runtime,
      authentication: { kind: "keyed", keys: [options.next.gatewayKey] },
    })
    runtimeSaved = true
    const target = context.session.owned
    if (target && !(await drainReplacement(context, target)))
      throw new Error("The gateway is still serving an agent request.")
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
    if (runtimeSaved)
      await context.settingsStore.save(previousSettings, previousRuntime)
    if (credentialsSaved) await restoreSavedAccount(context)
    throw error
  }
}
export async function rotateKey(context: ControllerContext): Promise<void> {
  if (context.session.legacy) {
    context.notice("The CLI gateway's authentication is managed in Terminal.")
    return
  }
  if (!context.account.credentials) {
    context.notice("Sign in before changing the gateway key.")
    return
  }
  const next = { ...context.account.credentials, gatewayKey: newGatewayKey() }
  const generation = context.account.accountGeneration
  await writeCredentials(context, () =>
    queueSettings(context, () =>
      replaceGatewayKey(context, { next, generation }),
    ),
  )
  await convergeGateway(context)
  await context.inspectConfigs()
  if (context.account.credentials === next)
    context.notice(
      "Gateway key changed. Review your agent configurations.",
      "info",
    )
}
function restoreSavedState(
  context: ControllerContext,
  options: {
    credentials: StoredCredentials | null
    authentication: NonNullable<RuntimeOverrides["authentication"]>
  },
): void {
  context.account.credentials = options.credentials
  context.account.savedCredentials = options.credentials
  context.session.authentication = options.authentication
}
async function restoredAuthentication(
  context: ControllerContext,
  credentials: StoredCredentials | null,
): Promise<NonNullable<RuntimeOverrides["authentication"]>> {
  const stored = context.settingsStore.runtime()
  if (stored?.authentication.kind === "none") return { kind: "none" }
  if (stored?.encryptedAuthentication) {
    if (!context.options.vault.decodeRuntimeAuthentication)
      throw new Error("Saved gateway authentication could not be unlocked.")
    const authentication =
      await context.options.vault.decodeRuntimeAuthentication(
        stored.encryptedAuthentication,
      )
    if (authentication.kind !== stored.authentication.kind)
      throw new Error("Saved gateway authentication does not match its policy.")
    return authentication
  }
  return credentials ?
      { kind: "keyed", keys: [credentials.gatewayKey] }
    : { kind: "none" }
}
export async function restore(context: ControllerContext): Promise<void> {
  if (await discoverLegacy(context)) return
  try {
    const loaded = await context.options.vault.load()
    const credentials = loaded ? credentialsSchema.parse(loaded) : null
    const authentication = await restoredAuthentication(context, credentials)
    restoreSavedState(context, { credentials, authentication })
  } catch {
    context.notice(
      "Saved sign-in or proxy settings could not be restored. Sign in again.",
    )
  }
  await context.inspectConfigs()
  if (await discoverLegacy(context)) return
  if (!context.account.credentials) return
  const attempt = newAuthorization(context)
  context.publish({ authorization: { kind: "validating", id: attempt.id } })
  const task = finishAuthentication(context, {
    token: context.account.credentials.githubToken,
    attempt,
    persistence: "restored",
  })
    .then(() => undefined)
    .catch((error: unknown) => authorizationFailed(context, attempt, error))
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
  }
}
export async function authorizeNativeAccount(
  context: ControllerContext,
  intent: Extract<
    NativeIntent,
    {
      kind: "authorize" | "cancel-authorization" | "authorize-with-token"
    }
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
  intent: Extract<
    NativeIntent,
    {
      kind: "ensure-running"
    }
  >,
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
