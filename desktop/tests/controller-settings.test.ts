import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises"

import type { ControllerOptions } from "../main/types"
import type { DesktopSnapshot } from "../shared/contracts"

import { createController } from "../main/controller"

let directory = ""

beforeAll(async () => {
  expect(execFileSync("/sbin/mount", { encoding: "utf8" })).toContain(
    "on /Volumes/mac-ssd (",
  )
  directory = await mkdtemp(
    "/Volumes/mac-ssd/AI/projects/copilot-proxy-api--6ce38f64251a/desktop-app/settings-tests-",
  )
})

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

function controller(
  platform: DesktopSnapshot["platform"],
  dataDirectory: string,
  adapters: Partial<
    Pick<ControllerOptions, "writeClipboard" | "applyLoginItem">
  > = {},
) {
  return createController({
    platform,
    dataDirectory,
    runtimePath: "unused-until-authenticated",
    version: "0.0.1",
    vault: {
      mode: "session-only",
      load: () => Promise.resolve(null),
      save: () => Promise.resolve(),
      clear: () => Promise.resolve(),
    },
    writeClipboard: () => undefined,
    openExternal: () => Promise.resolve(),
    ...adapters,
  })
}

describe("platform settings", () => {
  test("new Windows accounts use PowerShell and preserve a saved POSIX preference", async () => {
    const path = await mkdtemp(directory + "/windows-")
    const first = await controller("win32", path)
    expect(first.snapshot().settings.shell).toBe("powershell")
    const result = await first.invoke({
      kind: "save-settings",
      settings: { ...first.snapshot().settings, shell: "posix" },
    })
    expect(result.notice).toBeNull()
    await first.dispose()
    const restored = await controller("win32", path)
    expect(restored.snapshot().settings.shell).toBe("posix")
    await restored.dispose()
  })

  test("new macOS and Linux accounts use POSIX shell configuration", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      const path = await mkdtemp(directory + "/" + platform + "-")
      const native = await controller(platform, path)
      expect(native.snapshot().settings.shell).toBe("posix")
      await native.dispose()
    }
  })
})

describe("native command results", () => {
  test("clipboard and settings failures return an error without claiming a saved change", async () => {
    const path = await mkdtemp(directory + "/failure-")
    const loginItems: Array<boolean> = []
    const native = await controller("darwin", path, {
      writeClipboard: () => {
        throw new Error("fixture clipboard failure")
      },
      applyLoginItem: (enabled) => {
        loginItems.push(enabled)
        return Promise.resolve()
      },
    })
    const copied = await native.invoke({ kind: "copy", target: "base-url" })
    expect(copied.notice?.kind).toBe("error")
    const settingsPath = path + "/settings.json"
    await mkdir(settingsPath)
    const saved = await native.invoke({
      kind: "save-settings",
      settings: {
        ...copied.settings,
        launchAtLogin: true,
        preferredModel: "fixture-fast",
      },
    })
    expect(saved.notice?.kind).toBe("error")
    expect(saved.settings).toEqual(copied.settings)
    expect(loginItems).toEqual([true, false])
    await rename(settingsPath, path + "/failed-settings-directory")
    const copiedAgain = await native.invoke({
      kind: "save-settings",
      settings: copied.settings,
    })
    expect(copiedAgain.notice).toBeNull()
    await native.dispose()
  })
})
