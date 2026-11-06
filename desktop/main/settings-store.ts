import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"

import type { ControllerOptions } from "./types"

import {
  publicAuthenticationSchema,
  runtimeOptionsSchema,
} from "../../src/lib/proxy-contracts"
import { type DesktopSettings, settingsSchema } from "../shared/contracts"

export const nativeRuntimeSettingsSchema = z
  .object({
    options: runtimeOptionsSchema,
    authentication: publicAuthenticationSchema,
    encryptedAuthentication: z.string().max(262_144).nullable(),
  })
  .strict()
export type NativeRuntimeSettings = z.infer<typeof nativeRuntimeSettingsSchema>

export async function persistSettings(
  options: Pick<ControllerOptions, "applyLoginItem"> & {
    previous: DesktopSettings
    next: DesktopSettings
    save(settings: DesktopSettings): Promise<void>
  },
): Promise<"saved" | "unavailable" | "failed"> {
  const launchChanged =
    options.next.launchAtLogin !== options.previous.launchAtLogin
  const apply = options.applyLoginItem
  if (launchChanged && !apply) return "unavailable"
  try {
    if (launchChanged && apply) await apply(options.next.launchAtLogin)
    await options.save(options.next)
    return "saved"
  } catch {
    if (launchChanged && apply) {
      try {
        await apply(options.previous.launchAtLogin)
      } catch {
        return "failed"
      }
    }
    return "failed"
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
  })
  let writes = Promise.resolve()
  let nativeRuntime: NativeRuntimeSettings | null = null
  return {
    async load(): Promise<{
      settings: DesktopSettings
      recovered: boolean
      runtime: NativeRuntimeSettings | null
    }> {
      try {
        const raw: unknown = JSON.parse(await readFile(path, "utf8"))
        const { nativeRuntime: stored, ...settings } = fileSchema.parse(raw)
        nativeRuntime = stored ?? null
        return { settings, recovered: false, runtime: nativeRuntime }
      } catch (error) {
        const missing =
          error instanceof Error && "code" in error && error.code === "ENOENT"
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
    save(
      settings: DesktopSettings,
      runtime?: NativeRuntimeSettings | null,
    ): Promise<void> {
      const write = writes
        .then(async () => {
          const nextRuntime = runtime === undefined ? nativeRuntime : runtime
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
              },
              null,
              2,
            ) + "\n"
          await mkdir(dataDirectory, { recursive: true, mode: 0o700 })
          const temporary = join(dataDirectory, `.settings-${randomUUID()}.tmp`)
          try {
            await writeFile(temporary, serialized, { mode: 0o600, flag: "wx" })
            await rename(temporary, path)
            return nextRuntime
          } finally {
            await unlink(temporary).catch(() => undefined)
          }
        })
        .then((committed) => {
          nativeRuntime = committed
        })
      writes = write.catch(() => undefined)
      return write
    },
  }
}
