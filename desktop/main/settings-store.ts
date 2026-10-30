import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { ControllerOptions } from "./types"

import { type DesktopSettings, settingsSchema } from "../shared/contracts"

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
  let writes = Promise.resolve()
  return {
    async load(): Promise<{ settings: DesktopSettings; recovered: boolean }> {
      try {
        const raw: unknown = JSON.parse(await readFile(path, "utf8"))
        return { settings: platformSettings.parse(raw), recovered: false }
      } catch (error) {
        const missing =
          error instanceof Error && "code" in error && error.code === "ENOENT"
        return { settings: platformSettings.parse({}), recovered: !missing }
      }
    },
    save(settings: DesktopSettings): Promise<void> {
      const serialized =
        JSON.stringify(settingsSchema.parse(settings), null, 2) + "\n"
      const write = writes.then(async () => {
        await mkdir(dataDirectory, { recursive: true, mode: 0o700 })
        const temporary = join(dataDirectory, `.settings-${randomUUID()}.tmp`)
        try {
          await writeFile(temporary, serialized, { mode: 0o600, flag: "wx" })
          await rename(temporary, path)
        } finally {
          await unlink(temporary).catch(() => undefined)
        }
      })
      writes = write.catch(() => undefined)
      return write
    },
  }
}
