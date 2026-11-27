import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import {
  inspectAntigravitySettings,
  inspectLaunchAgents,
} from "~/lib/launch-agent-diagnostics"

let homeDirectory = ""

beforeEach(async () => {
  homeDirectory = await mkdtemp(join(tmpdir(), "copilot-launch-diagnostics-"))
})

afterEach(async () => {
  if (homeDirectory) await rm(homeDirectory, { recursive: true, force: true })
})

function settingsPath(): string {
  return join(homeDirectory, ".gemini", "antigravity-cli", "settings.json")
}

async function writeSettings(content: string): Promise<string> {
  const path = settingsPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, "utf8")
  return path
}

describe("Antigravity CLI read-only diagnostics", () => {
  test("reports absent without creating directories or files", async () => {
    const result = await inspectAntigravitySettings(homeDirectory)
    expect(result).toEqual({
      kind: "absent",
      target: "antigravity",
      path: settingsPath(),
    })
    expect(
      await stat(join(homeDirectory, ".gemini")).catch(() => null),
    ).toBeNull()
    expect(await inspectLaunchAgents(homeDirectory)).toEqual([result])
  })

  test("reads only modelProvider and model and ignores unrelated user fields", async () => {
    const content = JSON.stringify(
      {
        modelProvider: "vertex",
        model: "gemini-2.5-pro",
        trustedWorkspaces: ["/private/workspace/secret"],
        apiKey: "never-leak-this",
      },
      null,
      2,
    )
    const path = await writeSettings(content)
    const before = await stat(path)

    const result = await inspectAntigravitySettings(homeDirectory)
    expect(result).toEqual({
      kind: "compatible",
      target: "antigravity",
      path,
      existingModelProvider: "vertex",
      existingModel: "gemini-2.5-pro",
      summary:
        "Your Antigravity CLI settings file will stay untouched. The session command overrides only the launched process.",
    })
    expect(JSON.stringify(result)).not.toContain("trustedWorkspaces")
    expect(JSON.stringify(result)).not.toContain("never-leak-this")
    expect(await readFile(path, "utf8")).toBe(content)
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs)
  })

  test("parses BOM-prefixed JSONC with comments and trailing commas", async () => {
    const path = await writeSettings(
      '\uFEFF{\n  // user comment\n  "model": "gemini-4-neon",\n}\n',
    )
    const result = await inspectAntigravitySettings(homeDirectory)
    expect(result).toEqual({
      kind: "compatible",
      target: "antigravity",
      path,
      existingModelProvider: null,
      existingModel: "gemini-4-neon",
      summary:
        "Your Antigravity CLI settings file will stay untouched. The session command overrides only the launched process.",
    })
  })

  test("warns when modelProvider is persistently set to gemini", async () => {
    const path = await writeSettings(
      JSON.stringify({ modelProvider: "gemini", model: "gemini-2.5-pro" }),
    )
    const result = await inspectAntigravitySettings(homeDirectory)
    expect(result).toEqual({
      kind: "warning",
      target: "antigravity",
      path,
      code: "persistent-gemini-provider",
      message:
        "settings.json sets modelProvider to gemini. Bare agy requires GEMINI_API_KEY in the shell; the session launch command below still works without changing your file.",
    })
  })

  test("warns on duplicate keys, non-object roots, and non-string modelProvider", async () => {
    const path = await writeSettings(
      '{\n  "modelProvider": "vertex",\n  "modelProvider": "gemini"\n}\n',
    )
    const duplicate = await inspectAntigravitySettings(homeDirectory)
    expect(duplicate.kind).toBe("warning")
    if (duplicate.kind === "warning")
      expect(duplicate.code).toBe("duplicate-keys")

    await writeFile(path, '["not", "an", "object"]', "utf8")
    const nonObject = await inspectAntigravitySettings(homeDirectory)
    expect(nonObject.kind).toBe("warning")
    if (nonObject.kind === "warning")
      expect(nonObject.code).toBe("non-object-root")

    await writeFile(path, JSON.stringify({ modelProvider: 123 }), "utf8")
    const badProvider = await inspectAntigravitySettings(homeDirectory)
    expect(badProvider.kind).toBe("warning")
    if (badProvider.kind === "warning")
      expect(badProvider.code).toBe("invalid-provider-type")
  })

  test("reports invalid-file for broken JSON, oversized files, directories, and broken symlinks", async () => {
    const path = await writeSettings("{ not valid json")
    const invalidJson = await inspectAntigravitySettings(homeDirectory)
    expect(invalidJson.kind).toBe("invalid-file")

    await writeFile(path, " ".repeat(5 * 1024 * 1024 + 1), "utf8")
    const tooLarge = await inspectAntigravitySettings(homeDirectory)
    expect(tooLarge.kind).toBe("invalid-file")

    await rm(path, { force: true })
    await mkdir(path)
    const directory = await inspectAntigravitySettings(homeDirectory)
    expect(directory.kind).toBe("invalid-file")

    await rm(path, { recursive: true, force: true })
    await symlink(join(homeDirectory, "missing-target.json"), path)
    const brokenLink = await inspectAntigravitySettings(homeDirectory)
    expect(brokenLink.kind).toBe("invalid-file")
  })

  test("follows a valid symlink without mutating target", async () => {
    const realTarget = join(homeDirectory, "real-settings.json")
    const content = JSON.stringify({ model: "gemini-2.5-pro" })
    await writeFile(realTarget, content, "utf8")
    await mkdir(dirname(settingsPath()), { recursive: true })
    await symlink(realTarget, settingsPath())

    const result = await inspectAntigravitySettings(homeDirectory)
    expect(result.kind).toBe("compatible")
    if (result.kind === "compatible") {
      expect(result.existingModel).toBe("gemini-2.5-pro")
      expect(result.existingModelProvider).toBeNull()
    }
    expect(await readFile(realTarget, "utf8")).toBe(content)
  })
})
