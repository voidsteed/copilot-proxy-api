import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ControllerOptions } from "../main/types"
import type { DesktopSnapshot } from "../shared/contracts"

import {
  legacySnapshotSchema,
  runtimeOptionsSchema,
  sessionIdSchema,
} from "../../src/lib/proxy-contracts"
import { createController } from "../main/controller"
import { createControllerAccountState } from "../main/controller-account"
import { createControllerSessionState } from "../main/controller-session"
import { createSettingsStore } from "../main/settings-store"
import { applyLegacy, initialSnapshot } from "../main/snapshot"
import { settingsSchema, snapshotSchema } from "../shared/contracts"
import { startFixtureUpstream } from "../testing/upstream"
import { availablePort, eventually } from "./fixtures/runtime"

let directory = ""

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "copilot-proxy-settings-tests-"))
})

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

function controller(
  platform: DesktopSnapshot["platform"],
  dataDirectory: string,
  adapters: Partial<
    Pick<ControllerOptions, "writeClipboard" | "applyLoginItem" | "openFolder">
  > = {},
) {
  return createController({
    platform,
    dataDirectory,
    runtimePath: "unused-until-authenticated",
    version: "0.0.2",
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

  test("execute reports rejected outcomes, surfaces login-item error messages, and preserves notices on passive commands", async () => {
    const path = await mkdtemp(directory + "/outcomes-")
    const opened: Array<string> = []
    const native = await controller("darwin", path, {
      applyLoginItem: () =>
        Promise.reject(
          new Error("Install the app before enabling launch at login."),
        ),
      openFolder: (folder) => {
        opened.push(folder)
        return Promise.resolve()
      },
    })
    expect(native.snapshot().sessionId).toBeTruthy()
    expect(native.snapshot().sessionId).not.toBe("default")

    const rejectedCopy = await native.execute({
      kind: "copy",
      target: "base-url",
    })
    expect(rejectedCopy.outcome.kind).toBe("rejected")
    expect(rejectedCopy.snapshot.notice?.kind).toBe("error")

    const rejectedLogin = await native.execute({
      kind: "save-settings",
      settings: { launchAtLogin: true },
    })
    expect(rejectedLogin.outcome).toEqual({
      kind: "rejected",
      message: "Install the app before enabling launch at login.",
    })
    expect(rejectedLogin.snapshot.notice).toEqual({
      kind: "error",
      message: "Install the app before enabling launch at login.",
    })

    const inspected = await native.execute({
      kind: "inspect-agent-config",
      target: "codex",
    })
    expect(inspected.outcome).toEqual({ kind: "ok" })
    expect(inspected.snapshot.notice).toEqual(rejectedLogin.snapshot.notice)

    const openedFolder = await native.execute({
      kind: "open-config-folder",
      target: "codex",
    })
    expect(openedFolder.outcome).toEqual({ kind: "ok" })
    expect(opened).toHaveLength(1)
    expect(openedFolder.snapshot.notice).toEqual(rejectedLogin.snapshot.notice)

    const clearedProbe = await native.execute({ kind: "clear-probe" })
    expect(clearedProbe.outcome).toEqual({ kind: "ok" })
    expect(clearedProbe.snapshot.probe).toEqual({ kind: "idle" })
    expect(clearedProbe.snapshot.notice).toEqual(rejectedLogin.snapshot.notice)
    await native.dispose()
  })

  test("partial save-settings patches merge without clobbering concurrent agentModelChoices", async () => {
    const path = await mkdtemp(directory + "/partial-patch-")
    const native = await controller("darwin", path)
    const results = await Promise.all([
      native.execute({
        kind: "save-settings",
        settings: { agentModelChoices: { codex: "gpt-5.4" } },
      }),
      native.execute({
        kind: "save-settings",
        settings: { theme: "dark" },
      }),
      native.execute({
        kind: "save-settings",
        settings: { agentModelChoices: { opencode: "claude-sonnet-4" } },
      }),
    ])
    for (const result of results) expect(result.outcome).toEqual({ kind: "ok" })
    expect(native.snapshot().settings).toMatchObject({
      theme: "dark",
      agentModelChoices: {
        "claude-code": null,
        codex: "gpt-5.4",
        opencode: "claude-sonnet-4",
        antigravity: null,
      },
    })
    const persisted = settingsSchema.parse(
      JSON.parse(await readFile(join(path, "settings.json"), "utf8")),
    )
    expect(persisted.theme).toBe("dark")
    expect(persisted.agentModelChoices).toEqual({
      "claude-code": null,
      codex: "gpt-5.4",
      opencode: "claude-sonnet-4",
      antigravity: null,
    })
    await native.dispose()
  })
})

describe("antigravity settings and commands", () => {
  test("0.0.8 settings without antigravity load cleanly, select-agent-model persists antigravity, and configure-agent rejects antigravity", async () => {
    const dataDirectory = await mkdtemp(directory + "/antigravity-upgrade-")
    const homeDirectory = await mkdtemp(directory + "/antigravity-home-")
    const port = await availablePort()
    const legacySettings = {
      port,
      accountType: "individual",
      startOnLaunch: false,
      launchAtLogin: false,
      closeToTray: true,
      theme: "dark",
      preferredModel: "fixture-gpt-4.1",
      agentModelChoices: {
        "claude-code": "fixture-claude-sonnet",
        codex: "fixture-responses-only",
        opencode: null,
      },
      shell: "posix",
    }
    await writeFile(
      join(dataDirectory, "settings.json"),
      JSON.stringify(legacySettings, null, 2),
    )
    const upstream = await startFixtureUpstream()
    try {
      const native = await createController({
        platform: "darwin",
        dataDirectory,
        homeDirectory,
        runtimePath: "unused-when-startOnLaunch-is-false",
        fixtureOrigin: upstream.origin,
        version: "0.0.8",
        vault: {
          mode: "session-only",
          load: () =>
            Promise.resolve({
              githubToken: "fixture_github_token",
              gatewayKey: "fixture_gateway_key_01234567890123456789",
            }),
          save: () => Promise.resolve(),
          clear: () => Promise.resolve(),
        },
        writeClipboard: () => undefined,
        openExternal: () => Promise.resolve(),
      })
      try {
        await eventually(() =>
          native
            .snapshot()
            .models.some((model) => model.id === "gemini-2.5-pro"),
        )
        expect(native.snapshot().notice).toBeNull()
        expect(native.snapshot().settings.theme).toBe("dark")
        expect(native.snapshot().settings.agentModelChoices).toEqual({
          "claude-code": "fixture-claude-sonnet",
          codex: "fixture-responses-only",
          opencode: null,
          antigravity: null,
        })

        const selected = await native.execute({
          kind: "select-agent-model",
          target: "antigravity",
          modelId: "gemini-2.5-pro",
        })
        expect(selected.outcome).toEqual({ kind: "ok" })
        expect(selected.snapshot.settings.agentModelChoices.antigravity).toBe(
          "gemini-2.5-pro",
        )

        const nonGoogle = await native.execute({
          kind: "select-agent-model",
          target: "antigravity",
          modelId: "fixture-gpt-4.1",
        })
        expect(nonGoogle.outcome.kind).toBe("rejected")
        expect(native.snapshot().settings.agentModelChoices.antigravity).toBe(
          "gemini-2.5-pro",
        )

        const rejectedConfigure = await native.execute({
          kind: "configure-agent",
          target: "antigravity",
        })
        expect(rejectedConfigure.outcome).toEqual({
          kind: "rejected",
          message: "The app received an invalid command.",
        })

        const inspected = await native.execute({
          kind: "inspect-launch-agent",
          target: "antigravity",
        })
        expect(inspected.outcome).toEqual({ kind: "ok" })
        expect(inspected.snapshot.notice).toEqual(
          rejectedConfigure.snapshot.notice,
        )
        expect(inspected.snapshot.launchAgentDiagnostics).toEqual([
          {
            kind: "absent",
            target: "antigravity",
            path: join(
              homeDirectory,
              ".gemini",
              "antigravity-cli",
              "settings.json",
            ),
          },
        ])
        expect(
          await stat(join(homeDirectory, ".gemini")).catch(() => null),
        ).toBeNull()

        const reloaded = await createSettingsStore(dataDirectory).load()
        expect(reloaded.recovered).toBe(false)
        expect(reloaded.settings.agentModelChoices.antigravity).toBe(
          "gemini-2.5-pro",
        )
      } finally {
        await native.dispose()
      }
    } finally {
      await upstream.close()
    }
  })
})

describe("legacy port handling", () => {
  test("applyLegacy preserves a valid settings port when the CLI uses port 80 or below 1024", () => {
    const settings = settingsSchema.parse({ port: 4141 })
    let published = initialSnapshot({
      sessionId: "legacy-port-test",
      version: "0.0.3",
      platform: "darwin",
      fixture: true,
      storageMode: "session-only",
      settings,
      recovered: false,
    })
    const runtime = runtimeOptionsSchema.parse({
      port: 4141,
      accountType: "individual",
      manualApprove: false,
      rateLimitSeconds: null,
      rateLimitWait: false,
      responsesContextTrim: false,
      proxyFromEnvironment: false,
    })
    const context = {
      options: {
        dataDirectory: "/tmp",
        runtimePath: "unused",
        platform: "darwin" as const,
        version: "0.0.3",
        vault: {
          mode: "session-only" as const,
          load: () => Promise.resolve(null),
          save: () => Promise.resolve(),
          clear: () => Promise.resolve(),
        },
        writeClipboard: () => {},
        openExternal: () => Promise.resolve(),
      },
      homeDirectory: "/tmp",
      stateDirectory: "/tmp/native",
      fixtureOrigin: undefined,
      sessionId: sessionIdSchema.parse("legacy-port-test"),
      settingsStore: createSettingsStore("/tmp"),
      get state() {
        return published
      },
      set state(next) {
        published = next
      },
      account: createControllerAccountState(),
      session: createControllerSessionState(runtime),
      publish(patch: Partial<typeof published>) {
        published = { ...published, ...patch, revision: published.revision + 1 }
      },
      notice() {},
      own() {},
      inspectConfigs: () => Promise.resolve(),
      refresh: () => Promise.resolve({ kind: "ok" as const }),
      activeConnection: () => null,
      nativeSource: () => {
        throw new Error("unused")
      },
    }
    for (const [rootUrl, apiUrl] of [
      ["http://localhost/", "http://localhost/v1"],
      ["http://localhost:80/", "http://localhost:80/v1"],
      ["http://localhost:808/", "http://localhost:808/v1"],
    ] as const) {
      const legacy = legacySnapshotSchema.parse({
        kind: "legacy",
        connection: {
          rootUrl,
          apiUrl,
          authentication: { kind: "none" },
        },
        status: "reachable",
        account: { kind: "external-unverified" },
        capabilities: {
          kind: "legacy",
          runtime: "read-only",
          account: "unverified",
          activity: "observed",
          drain: false,
        },
        catalog: [],
        usage: null,
        activity: [],
        totals: {
          requests: null,
          errors: null,
          inputTokens: null,
          outputTokens: null,
          cachedTokens: null,
        },
        observedAt: "2026-11-24T00:00:00.000Z",
      })
      applyLegacy(context, legacy)
      const parsed = snapshotSchema.parse(published)
      expect(parsed.settings.port).toBe(4141)
      expect(String(parsed.connection?.rootUrl)).toBe(rootUrl)
    }
  })
})
