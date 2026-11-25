import type { Node as JsonNode, ParseError } from "jsonc-parser"

import { getNodeValue, parseTree } from "jsonc-parser"
import { lstat, readFile, realpath, stat } from "node:fs/promises"
import { join } from "node:path"

import {
  type LaunchAgentDiagnostics,
  launchAgentDiagnosticsSchema,
} from "~/lib/proxy-contracts"

const maximumSettingsBytes = 5 * 1024 * 1024
const compatibleSummary =
  "Your Antigravity CLI settings file will stay untouched. The session command overrides only the launched process."
const persistentGeminiMessage =
  "settings.json sets modelProvider to gemini. Bare agy requires GEMINI_API_KEY in the shell; the session launch command below still works without changing your file."

function errorCode(error: unknown): string | undefined {
  return (
      error instanceof Error
        && "code" in error
        && typeof error.code === "string"
    ) ?
      error.code
    : undefined
}

function stripBom(text: string): string {
  return text.startsWith("\uFEFF") ? text.slice(1) : text
}

function hasDuplicateJsonKeys(node: JsonNode): boolean {
  if (node.type === "object") {
    const names = new Set<string>()
    for (const property of node.children ?? []) {
      const name: unknown = property.children?.[0]?.value
      if (typeof name !== "string" || names.has(name)) return true
      names.add(name)
    }
  }
  for (const child of node.children ?? []) {
    if (hasDuplicateJsonKeys(child)) return true
  }
  return false
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseAntigravityJsonc(
  path: string,
  text: string,
): LaunchAgentDiagnostics {
  const errors: Array<ParseError> = []
  const tree = parseTree(stripBom(text), errors, {
    allowTrailingComma: true,
    allowEmptyContent: true,
  })
  if (errors.length > 0) {
    return launchAgentDiagnosticsSchema.parse({
      kind: "invalid-file",
      target: "antigravity",
      path,
      message: "Antigravity CLI settings cannot be parsed as JSON.",
    })
  }
  if (!tree) {
    return launchAgentDiagnosticsSchema.parse({
      kind: "compatible",
      target: "antigravity",
      path,
      existingModelProvider: null,
      existingModel: null,
      summary: compatibleSummary,
    })
  }
  if (tree.type !== "object") {
    return launchAgentDiagnosticsSchema.parse({
      kind: "warning",
      target: "antigravity",
      path,
      code: "non-object-root",
      message:
        "settings.json does not contain a JSON object. The session launch command below still works without changing your file.",
    })
  }
  if (hasDuplicateJsonKeys(tree)) {
    return launchAgentDiagnosticsSchema.parse({
      kind: "warning",
      target: "antigravity",
      path,
      code: "duplicate-keys",
      message:
        "settings.json contains duplicate JSON keys. Review the file if bare agy behaves unexpectedly.",
    })
  }
  const parsed: unknown = getNodeValue(tree)
  if (!isPlainRecord(parsed)) {
    return launchAgentDiagnosticsSchema.parse({
      kind: "warning",
      target: "antigravity",
      path,
      code: "non-object-root",
      message:
        "settings.json does not contain a JSON object. The session launch command below still works without changing your file.",
    })
  }
  const rawProvider =
    Object.hasOwn(parsed, "modelProvider") ? parsed.modelProvider : undefined
  if (rawProvider !== undefined && typeof rawProvider !== "string") {
    return launchAgentDiagnosticsSchema.parse({
      kind: "warning",
      target: "antigravity",
      path,
      code: "invalid-provider-type",
      message:
        "settings.json has a non-string modelProvider value. The session launch command below still works without changing your file.",
    })
  }
  if (rawProvider === "gemini") {
    return launchAgentDiagnosticsSchema.parse({
      kind: "warning",
      target: "antigravity",
      path,
      code: "persistent-gemini-provider",
      message: persistentGeminiMessage,
    })
  }
  const rawModel = Object.hasOwn(parsed, "model") ? parsed.model : undefined
  return launchAgentDiagnosticsSchema.parse({
    kind: "compatible",
    target: "antigravity",
    path,
    existingModelProvider:
      typeof rawProvider === "string" && rawProvider.length > 0 ?
        rawProvider
      : null,
    existingModel:
      typeof rawModel === "string" && rawModel.length > 0 ? rawModel : null,
    summary: compatibleSummary,
  })
}

export async function inspectAntigravitySettings(
  homeDirectory: string,
): Promise<LaunchAgentDiagnostics> {
  const path = join(
    homeDirectory,
    ".gemini",
    "antigravity-cli",
    "settings.json",
  )
  let entry
  try {
    entry = await lstat(path)
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return launchAgentDiagnosticsSchema.parse({
        kind: "absent",
        target: "antigravity",
        path,
      })
    }
    return launchAgentDiagnosticsSchema.parse({
      kind: "invalid-file",
      target: "antigravity",
      path,
      message: "Antigravity CLI settings could not be read.",
    })
  }
  if (!entry.isFile() && !entry.isSymbolicLink()) {
    return launchAgentDiagnosticsSchema.parse({
      kind: "invalid-file",
      target: "antigravity",
      path,
      message: "Antigravity CLI settings must be a regular file.",
    })
  }
  try {
    const resolvedPath = await realpath(path)
    const metadata = await stat(resolvedPath, { bigint: true })
    if (!metadata.isFile() || metadata.size > BigInt(maximumSettingsBytes)) {
      return launchAgentDiagnosticsSchema.parse({
        kind: "invalid-file",
        target: "antigravity",
        path,
        message:
          "Antigravity CLI settings must be a regular file smaller than 5 MB.",
      })
    }
    const text = await readFile(resolvedPath, "utf8")
    return parseAntigravityJsonc(path, text)
  } catch {
    return launchAgentDiagnosticsSchema.parse({
      kind: "invalid-file",
      target: "antigravity",
      path,
      message: "Antigravity CLI settings could not be read.",
    })
  }
}

export async function inspectLaunchAgents(
  homeDirectory: string,
): Promise<Array<LaunchAgentDiagnostics>> {
  return [await inspectAntigravitySettings(homeDirectory)]
}
