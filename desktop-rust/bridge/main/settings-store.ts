import { randomBytes, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"

import type {
  ControlResult,
  RuntimeOptions,
  RuntimeOverrides,
} from "../../../src/lib/proxy-contracts"
import type { ControllerOptions, CredentialVault } from "./types"

import {
  publicAuthenticationSchema,
  runtimeOptionsSchema,
} from "../../../src/lib/proxy-contracts"
import {
  type DesktopSettings,
  type DesktopSettingsPatch,
  settingsSchema,
} from "../shared/contracts"

function mergeAgentModelChoices(
  current: DesktopSettings["agentModelChoices"],
  patch: NonNullable<DesktopSettingsPatch["agentModelChoices"]>,
): DesktopSettings["agentModelChoices"] {
  return {
    ...current,
    ...(patch["claude-code"] !== undefined ?
      { "claude-code": patch["claude-code"] }
    : {}),
    ...(patch.codex !== undefined ? { codex: patch.codex } : {}),
    ...(patch.opencode !== undefined ? { opencode: patch.opencode } : {}),
    ...(patch.antigravity !== undefined ?
      { antigravity: patch.antigravity }
    : {}),
  }
}

export function mergeSettingsPatch(
  current: DesktopSettings,
  patch: DesktopSettingsPatch,
): DesktopSettings {
  return {
    ...current,
    ...(patch.port !== undefined ? { port: patch.port } : {}),
    ...(patch.accountType !== undefined ?
      { accountType: patch.accountType }
    : {}),
    ...(patch.startOnLaunch !== undefined ?
      { startOnLaunch: patch.startOnLaunch }
    : {}),
    ...(patch.launchAtLogin !== undefined ?
      { launchAtLogin: patch.launchAtLogin }
    : {}),
    ...(patch.closeToTray !== undefined ?
      { closeToTray: patch.closeToTray }
    : {}),
    ...(patch.theme !== undefined ? { theme: patch.theme } : {}),
    ...(patch.preferredModel !== undefined ?
      { preferredModel: patch.preferredModel }
    : {}),
    ...(patch.shell !== undefined ? { shell: patch.shell } : {}),
    agentModelChoices:
      patch.agentModelChoices ?
        mergeAgentModelChoices(
          current.agentModelChoices,
          patch.agentModelChoices,
        )
      : current.agentModelChoices,
  }
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

export async function encodeRuntimeSettings(options: {
  vault: CredentialVault
  runtime: RuntimeOptions
  authentication: NonNullable<RuntimeOverrides["authentication"]>
}): Promise<NativeRuntimeSettings> {
  const { vault, runtime, authentication } = options
  let encryptedAuthentication: string | null = null
  if (authentication.kind === "keyed" && vault.mode === "encrypted") {
    if (!vault.encodeRuntimeAuthentication)
      throw new Error("Encrypted gateway settings are unavailable.")
    encryptedAuthentication =
      await vault.encodeRuntimeAuthentication(authentication)
    if (!encryptedAuthentication)
      throw new Error("Encrypted gateway settings could not be saved.")
  }
  return {
    options: runtime,
    authentication: { kind: authentication.kind },
    encryptedAuthentication,
  }
}

export const credentialsSchema = z
  .object({
    githubToken: z.string().min(1).max(16384),
    gatewayKey: z.string().min(1).max(4096),
  })
  .strict()

export const newGatewayKey = () => randomBytes(32).toString("base64url")

export async function runBestEffort(task: () => Promise<void>): Promise<void> {
  await Promise.resolve()
    .then(task)
    .catch(() => undefined)
}

export async function decodeRestoredAuthentication(options: {
  vault: CredentialVault
  stored: NativeRuntimeSettings | null
  gatewayKey: string | null
}): Promise<NonNullable<RuntimeOverrides["authentication"]>> {
  const { vault, stored, gatewayKey } = options
  if (stored?.authentication.kind === "none") return { kind: "none" }
  if (stored?.encryptedAuthentication) {
    if (!vault.decodeRuntimeAuthentication)
      throw new Error("Saved gateway authentication could not be unlocked.")
    const authentication = await vault.decodeRuntimeAuthentication(
      stored.encryptedAuthentication,
    )
    if (authentication.kind !== stored.authentication.kind)
      throw new Error("Saved gateway authentication does not match its policy.")
    return authentication
  }
  return gatewayKey ? { kind: "keyed", keys: [gatewayKey] } : { kind: "none" }
}

export const nativeRuntimeSettingsSchema = z
  .object({
    options: runtimeOptionsSchema,
    authentication: publicAuthenticationSchema,
    encryptedAuthentication: z.string().max(262_144).nullable(),
  })
  .strict()
export type NativeRuntimeSettings = z.infer<typeof nativeRuntimeSettingsSchema>

export type PersistSettingsResult =
  | { kind: "saved" }
  | { kind: "unavailable"; message: string }
  | { kind: "failed"; message: string }

export async function persistSettings(
  options: Pick<ControllerOptions, "applyLoginItem"> & {
    previous: DesktopSettings
    next: DesktopSettings
    save(settings: DesktopSettings): Promise<void>
  },
): Promise<PersistSettingsResult> {
  const launchChanged =
    options.next.launchAtLogin !== options.previous.launchAtLogin
  const apply = options.applyLoginItem
  if (launchChanged && !apply) {
    return {
      kind: "unavailable",
      message: "Launch at login is unavailable in this session.",
    }
  }
  if (launchChanged && apply) {
    try {
      await apply(options.next.launchAtLogin)
    } catch (error) {
      await runBestEffort(async () => {
        await apply(options.previous.launchAtLogin)
      })
      const message =
        error instanceof Error && error.message.trim().length > 0 ?
          error.message.trim()
        : "Launch at login could not be updated."
      return { kind: "unavailable", message }
    }
  }
  try {
    await options.save(options.next)
    return { kind: "saved" }
  } catch {
    if (launchChanged && apply) {
      await runBestEffort(async () => {
        await apply(options.previous.launchAtLogin)
      })
    }
    return {
      kind: "failed",
      message:
        "Settings could not be saved. Check system permissions and try again.",
    }
  }
}

export function createSettingsStore(
  dataDirectory: string,
  defaultShell: DesktopSettings["shell"] = "posix",
) {
  const path = join(dataDirectory, "settings.json")
  const platformSettings = settingsSchema.extend({
    shell: settingsSchema.shape.shell.default(defaultShell),
  })
  const fileSchema = platformSettings.extend({
    nativeRuntime: nativeRuntimeSettingsSchema.optional(),
    preferManagedPort: z.boolean().optional(),
  })
  let writes = Promise.resolve()
  let nativeRuntime: NativeRuntimeSettings | null = null
  let managedPortPreferred = false
  return {
    async load(): Promise<{
      settings: DesktopSettings
      recovered: boolean
      runtime: NativeRuntimeSettings | null
    }> {
      try {
        const raw: unknown = JSON.parse(await readFile(path, "utf8"))
        const {
          nativeRuntime: stored,
          preferManagedPort,
          ...settings
        } = fileSchema.parse(raw)
        nativeRuntime = stored ?? null
        managedPortPreferred = preferManagedPort === true
        return { settings, recovered: false, runtime: nativeRuntime }
      } catch (error) {
        const missing =
          error instanceof Error && "code" in error && error.code === "ENOENT"
        managedPortPreferred = false
        return {
          settings: platformSettings.parse({}),
          recovered: !missing,
          runtime: null,
        }
      }
    },
    runtime(): NativeRuntimeSettings | null {
      return nativeRuntime && structuredClone(nativeRuntime)
    },
    preferManagedPort(): boolean {
      return managedPortPreferred
    },
    save(
      settings: DesktopSettings,
      runtime?: NativeRuntimeSettings | null,
      options?: { preferManagedPort?: boolean },
    ): Promise<void> {
      const write = writes
        .then(async () => {
          const nextRuntime = runtime === undefined ? nativeRuntime : runtime
          const nextPreferManagedPort =
            options?.preferManagedPort ?? managedPortPreferred
          const serialized =
            JSON.stringify(
              {
                ...settingsSchema.parse(settings),
                ...(nextRuntime ?
                  {
                    nativeRuntime:
                      nativeRuntimeSettingsSchema.parse(nextRuntime),
                  }
                : {}),
                ...(nextPreferManagedPort ? { preferManagedPort: true } : {}),
              },
              null,
              2,
            ) + "\n"
          await mkdir(dataDirectory, { recursive: true, mode: 0o700 })
          const temporary = join(dataDirectory, `.settings-${randomUUID()}.tmp`)
          try {
            await writeFile(temporary, serialized, { mode: 0o600, flag: "wx" })
            await rename(temporary, path)
            return { nextRuntime, nextPreferManagedPort }
          } finally {
            await unlink(temporary).catch(() => undefined)
          }
        })
        .then(({ nextRuntime, nextPreferManagedPort }) => {
          nativeRuntime = nextRuntime
          managedPortPreferred = nextPreferManagedPort
        })
      writes = write.catch(() => undefined)
      return write
    },
  }
}
