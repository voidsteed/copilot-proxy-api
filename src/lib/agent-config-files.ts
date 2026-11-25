import type { Node as JsonNode, ParseError } from "jsonc-parser"
import type { BigIntStats } from "node:fs"
import type { FileHandle } from "node:fs/promises"

import { applyEdits, getNodeValue, modify, parseTree } from "jsonc-parser"
import { randomUUID } from "node:crypto"
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { parse as parseToml, stringify as stringifyToml } from "smol-toml"
import { z } from "zod"

import type {
  ConfigurableAgent,
  ConfigureMissingAgentOptions,
} from "~/lib/proxy-contracts"

type ConfigValue =
  | string
  | number
  | boolean
  | null
  | bigint
  | Date
  | Array<ConfigValue>
  | ConfigObject
export interface ConfigObject {
  [key: string]: ConfigValue
}
const valueSchema: z.ZodType<ConfigValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.custom<number>((value) => typeof value === "number"),
    z.boolean(),
    z.null(),
    z.bigint(),
    z.instanceof(Date),
    z.array(valueSchema),
    z.record(z.string(), valueSchema),
  ]),
)
const documentSchema = z.record(z.string(), valueSchema)
const maximumConfigBytes = 5 * 1024 * 1024
const writers = new Map<string, Promise<void>>()

const invalidSyntax =
  "The configuration file cannot be parsed. Fix its syntax before configuring."
const unsupportedLayout =
  "This configuration layout cannot be extended while preserving its existing values."

export interface Addition {
  path: Array<string>
  value: string | number | boolean
}

export interface ConfigFile {
  path: string
  resolvedPath: string
  format: "jsonc" | "toml"
  text: string
  document: ConfigObject
  disk: { kind: "missing" } | { kind: "existing"; metadata: BigIntStats }
}

export type ConfigRead =
  | { kind: "ready"; file: ConfigFile }
  | { kind: "invalid"; path: string; message: string }
export type Entry =
  | { kind: "absent" }
  | { kind: "existing"; value: ConfigValue }
  | { kind: "blocked"; path: Array<string> }
class ConfigRejected extends Error {}

export async function withConfigWriter<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  const result = (writers.get(path) ?? Promise.resolve()).then(operation)
  const tail = result.then(
    () => undefined,
    () => undefined,
  )
  writers.set(path, tail)
  try {
    return await result
  } finally {
    if (writers.get(path) === tail) writers.delete(path)
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected agent target: ${String(value)}`)
}

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

export function agentConfigFolder(
  target: ConfigurableAgent,
  homeDirectory: string,
): string {
  switch (target) {
    case "claude-code": {
      return join(homeDirectory, ".claude")
    }
    case "codex": {
      return join(homeDirectory, ".codex")
    }
    case "opencode": {
      const xdg = process.env.XDG_CONFIG_HOME
      if (
        xdg
        && isAbsolute(xdg)
        && resolve(homeDirectory) === resolve(homedir())
      ) {
        return join(xdg, "opencode")
      }
      return join(homeDirectory, ".config", "opencode")
    }
    default: {
      return assertNever(target)
    }
  }
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT"
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

async function agentPath(
  target: ConfigurableAgent,
  homeDirectory: string,
): Promise<string> {
  const folder = agentConfigFolder(target, homeDirectory)
  switch (target) {
    case "claude-code": {
      return join(folder, "settings.json")
    }
    case "codex": {
      return join(folder, "config.toml")
    }
    case "opencode": {
      const json = join(folder, "opencode.json")
      const jsonc = join(folder, "opencode.jsonc")
      const [hasJson, hasJsonc] = await Promise.all([
        exists(json),
        exists(jsonc),
      ])
      if (hasJson && hasJsonc) {
        throw new ConfigRejected(
          "Both OpenCode configuration files exist. Resolve the duplicate before configuring.",
        )
      }
      return hasJson ? json : jsonc
    }
    default: {
      return assertNever(target)
    }
  }
}

async function resolveDestination(path: string): Promise<string> {
  let ancestor = resolve(path)
  const remaining: Array<string> = []
  while (true) {
    let entry
    try {
      entry = await lstat(ancestor)
    } catch (error) {
      if (!isMissing(error)) throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) throw error
      remaining.unshift(basename(ancestor))
      ancestor = parent
      continue
    }
    const destination = await realpath(ancestor)
    if (remaining.length > 0 && !(await stat(destination)).isDirectory()) {
      throw new ConfigRejected("The configuration folder is not a directory.")
    }
    if (remaining.length === 0 && !entry.isFile() && !entry.isSymbolicLink()) {
      throw new ConfigRejected("The configuration path is not a regular file.")
    }
    return join(destination, ...remaining)
  }
}

function rejectDuplicateJsonKeys(node: JsonNode): void {
  if (node.type === "object") {
    const names = new Set<string>()
    for (const property of node.children ?? []) {
      const name: unknown = property.children?.[0]?.value
      if (typeof name !== "string" || names.has(name)) {
        throw new ConfigRejected(invalidSyntax)
      }
      names.add(name)
    }
  }
  for (const child of node.children ?? []) rejectDuplicateJsonKeys(child)
}

function parseDocument(
  text: string,
  format: ConfigFile["format"],
): ConfigObject {
  const source = stripBom(text)
  try {
    if (format === "toml")
      return documentSchema.parse(
        parseToml(source, { integersAsBigInt: "asNeeded" }),
      )
    const errors: Array<ParseError> = []
    const tree = parseTree(source, errors, {
      allowTrailingComma: true,
      allowEmptyContent: true,
    })
    if (errors.length > 0) throw new ConfigRejected(invalidSyntax)
    if (!tree) return {}
    rejectDuplicateJsonKeys(tree)
    const value: unknown = getNodeValue(tree)
    return documentSchema.parse(value)
  } catch {
    throw new ConfigRejected(invalidSyntax)
  }
}

export async function readAgentConfig(
  target: ConfigurableAgent,
  homeDirectory: string,
): Promise<ConfigRead> {
  const defaultFiles: Record<ConfigurableAgent, string> = {
    "claude-code": "settings.json",
    codex: "config.toml",
    opencode: "opencode.jsonc",
  }
  const formats: Record<ConfigurableAgent, ConfigFile["format"]> = {
    "claude-code": "jsonc",
    codex: "toml",
    opencode: "jsonc",
  }
  let path = join(
    agentConfigFolder(target, homeDirectory),
    defaultFiles[target],
  )
  try {
    path = await agentPath(target, homeDirectory)
    const resolvedPath = await resolveDestination(path)
    const format = formats[target]
    if (!(await exists(path))) {
      return {
        kind: "ready",
        file: {
          path,
          resolvedPath,
          format,
          text: "",
          document: {},
          disk: { kind: "missing" },
        },
      }
    }
    const metadata = await stat(resolvedPath, { bigint: true })
    if (!metadata.isFile() || metadata.size > BigInt(maximumConfigBytes)) {
      throw new ConfigRejected(
        "The configuration must be a regular file smaller than 5 MB.",
      )
    }
    const text = await readFile(resolvedPath, "utf8")
    return {
      kind: "ready",
      file: {
        path,
        resolvedPath,
        format,
        text,
        document: parseDocument(text, format),
        disk: { kind: "existing", metadata },
      },
    }
  } catch (error) {
    return {
      kind: "invalid",
      path,
      message:
        error instanceof ConfigRejected ?
          error.message
        : "The configuration file could not be read.",
    }
  }
}

function isObject(value: ConfigValue): value is ConfigObject {
  return (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && !(value instanceof Date)
  )
}

export function entryAt(document: ConfigObject, path: Array<string>): Entry {
  let value: ConfigValue = document
  for (const [index, name] of path.entries()) {
    if (!isObject(value)) return { kind: "blocked", path: path.slice(0, index) }
    if (!Object.hasOwn(value, name)) return { kind: "absent" }
    value = value[name]
  }
  return { kind: "existing", value }
}

export function existingString(
  document: ConfigObject,
  path: Array<string>,
): string | null {
  const entry = entryAt(document, path)
  return (
      entry.kind === "existing"
        && typeof entry.value === "string"
        && entry.value.length > 0
    ) ?
      entry.value
    : null
}

export function configuredHeader(
  document: ConfigObject,
  path: Array<string>,
  name: string,
): string | null {
  const headers = entryAt(document, path)
  if (headers.kind !== "existing" || !isObject(headers.value)) return null
  const header = Object.entries(headers.value).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )
  return header && typeof header[1] === "string" ? header[1] : null
}

export function parseBearerAuthorization(header: string): string | null {
  const match = /^bearer\s+(\S+)$/iu.exec(header.trim())
  return match ? match[1] : null
}

export function literalCredentials(
  target: ConfigurableAgent,
  document: ConfigObject,
): Array<string> {
  let candidates: Array<string | null>
  switch (target) {
    case "claude-code": {
      candidates = [
        existingString(document, ["env", "ANTHROPIC_AUTH_TOKEN"]),
        existingString(document, ["env", "ANTHROPIC_API_KEY"]),
      ]
      break
    }
    case "codex": {
      const provider = [
        "model_providers",
        existingString(document, ["model_provider"]) ?? "copilot_proxy",
      ]
      const header = configuredHeader(
        document,
        [...provider, "http_headers"],
        "Authorization",
      )
      candidates = [
        existingString(document, [...provider, "experimental_bearer_token"]),
        header !== null ? parseBearerAuthorization(header) : null,
        configuredHeader(document, [...provider, "http_headers"], "x-api-key"),
      ]
      break
    }
    case "opencode": {
      const model = existingString(document, ["model"])
      const separator = model?.indexOf("/") ?? -1
      const provider =
        separator > 0 && model ? model.slice(0, separator) : "copilot_proxy"
      candidates = [
        existingString(document, ["provider", provider, "options", "apiKey"]),
      ]
      break
    }
    default: {
      return assertNever(target)
    }
  }
  return candidates.filter(
    (key): key is string =>
      key !== null
      && key.length > 0
      && key.length <= 4096
      && !/^(?:\$|<|\{(?:env|file):)/u.test(key),
  )
}

function addToDocument(
  document: ConfigObject,
  addition: Addition,
  depth = 0,
): ConfigObject {
  const name = addition.path[depth]
  if (depth === addition.path.length - 1)
    return { ...document, [name]: addition.value }
  const child = Object.hasOwn(document, name) ? document[name] : {}
  if (!isObject(child)) throw new ConfigRejected(unsupportedLayout)
  return { ...document, [name]: addToDocument(child, addition, depth + 1) }
}

function renderJsonc(file: ConfigFile, additions: Array<Addition>): string {
  let text =
    parseTree(file.text) ?
      file.text
    : `${file.text}${file.text.endsWith("\n") || !file.text ? "" : "\n"}{}\n`
  const indentation = file.text.match(/\n([\t ]+)"/u)?.[1]
  const formattingOptions = {
    insertSpaces: !indentation?.includes("\t"),
    tabSize:
      indentation && !indentation.includes("\t") ? indentation.length : 2,
    eol: file.text.includes("\r\n") ? "\r\n" : "\n",
  }
  for (const addition of additions)
    text = applyEdits(
      text,
      modify(text, addition.path, addition.value, { formattingOptions }),
    )
  return text
}

interface TomlSection {
  path: Array<string> | null
  end: number
}

interface TomlScanState {
  string: { quote: '"' | "'"; multiline: boolean } | null
  bracketDepth: number
  braceDepth: number
  atLineStart: boolean
  lineStart: number
  index: number
}

function headerPath(header: string): Array<string> {
  let object: ConfigValue = parseDocument(`${header}\n`, "toml")
  const path: Array<string> = []
  while (isObject(object)) {
    const keys: Array<string> = Object.keys(object)
    if (keys.length === 0) return path
    if (keys.length !== 1) throw new ConfigRejected(unsupportedLayout)
    const key = keys[0]
    path.push(key)
    object = object[key]
  }
  return []
}

function consumeQuoteRun(text: string, index: number, quote: string): number {
  let end = index
  while (text[end] === quote) end += 1
  // TOML allows up to two trailing content quotes immediately before the closing triple-quote.
  return index + Math.min(end - index, 5)
}

function findLineEnd(text: string, from: number): number {
  let end = from
  while (end < text.length && text[end] !== "\n" && text[end] !== "\r") end += 1
  return end
}

function stepTomlString(text: string, state: TomlScanState): void {
  const active = state.string
  if (!active) return
  const char = text[state.index]
  const delimiter = active.multiline ? active.quote.repeat(3) : active.quote
  if (active.quote === '"' && char === "\\" && state.index + 1 < text.length) {
    state.index += 2
  } else if (text.startsWith(delimiter, state.index)) {
    state.index =
      active.multiline ?
        consumeQuoteRun(text, state.index, active.quote)
      : state.index + 1
    state.string = null
  } else if (!active.multiline && (char === "\n" || char === "\r")) {
    state.string = null
  } else {
    state.index += 1
  }
}

function stepTomlCodeChar(text: string, state: TomlScanState): void {
  const char = text[state.index]
  if (char === "#") {
    state.index = findLineEnd(text, state.index)
    return
  }
  if (char === '"' || char === "'") {
    const multiline = text.startsWith(char.repeat(3), state.index)
    state.index += multiline ? 3 : 1
    state.string = { quote: char, multiline }
    return
  }
  if (char === "[" || char === "]") {
    state.bracketDepth = Math.max(
      0,
      state.bracketDepth + (char === "[" ? 1 : -1),
    )
  } else if (char === "{" || char === "}") {
    state.braceDepth = Math.max(0, state.braceDepth + (char === "{" ? 1 : -1))
  }
  state.index += 1
}

function stepTomlCode(
  text: string,
  state: TomlScanState,
  sections: Array<TomlSection>,
): void {
  const char = text[state.index]
  if (char === "\n" || char === "\r") {
    state.index += char === "\r" && text[state.index + 1] === "\n" ? 2 : 1
    state.atLineStart = true
    state.lineStart = state.index
    return
  }
  if (state.atLineStart && (char === " " || char === "\t")) {
    state.index += 1
    return
  }
  if (
    state.atLineStart
    && state.bracketDepth === 0
    && state.braceDepth === 0
    && char === "["
  ) {
    const lineEnd = findLineEnd(text, state.index)
    const previous = sections.at(-1)
    if (previous) previous.end = state.lineStart
    const header = text.slice(state.lineStart, lineEnd).trim()
    sections.push({
      path: header.startsWith("[[") ? null : headerPath(header),
      end: text.length,
    })
    state.index = lineEnd
    state.atLineStart = false
    return
  }
  state.atLineStart = false
  stepTomlCodeChar(text, state)
}

function tomlSections(text: string): Array<TomlSection> {
  const sections: Array<TomlSection> = [{ path: [], end: text.length }]
  const state: TomlScanState = {
    string: null,
    bracketDepth: 0,
    braceDepth: 0,
    atLineStart: true,
    lineStart: 0,
    index: 0,
  }
  while (state.index < text.length) {
    if (state.string) stepTomlString(text, state)
    else stepTomlCode(text, state, sections)
  }
  return sections
}

function quoteTomlKey(key: string): string {
  return /^[\w-]+$/u.test(key) ? key : JSON.stringify(key)
}

function renderToml(file: ConfigFile, additions: Array<Addition>): string {
  const sections = tomlSections(file.text)
  const inserts = new Map<number, Array<string>>()
  for (const addition of additions) {
    const parent = addition.path.slice(0, -1)
    const section = sections
      .filter(
        (item): item is { path: Array<string>; end: number } =>
          item.path !== null
          && item.path.length <= parent.length
          && item.path.every((part, index) => part === parent[index]),
      )
      .sort((left, right) => right.path.length - left.path.length)[0]
    const key = addition.path
      .slice(section.path.length)
      .map((part) => quoteTomlKey(part))
      .join(".")
    const assignment = stringifyToml({ value: addition.value })
      .trim()
      .slice("value = ".length)
    const lines = inserts.get(section.end) ?? []
    lines.push(`${key} = ${assignment}`)
    inserts.set(section.end, lines)
  }
  const eol = file.text.includes("\r\n") ? "\r\n" : "\n"
  let text = file.text
  for (const [offset, lines] of [...inserts].sort(
    ([left], [right]) => right - left,
  )) {
    const prefix = offset > 0 && text[offset - 1] !== "\n" ? eol : ""
    text =
      text.slice(0, offset)
      + prefix
      + lines.join(eol)
      + eol
      + text.slice(offset)
  }
  return text
}

function prepareText(file: ConfigFile, additions: Array<Addition>): string {
  const cleanFile =
    file.text.startsWith("\uFEFF") ?
      { ...file, text: stripBom(file.text) }
    : file
  const text =
    cleanFile.format === "jsonc" ?
      renderJsonc(cleanFile, additions)
    : renderToml(cleanFile, additions)
  let expected = file.document
  for (const addition of additions) {
    if (entryAt(file.document, addition.path).kind !== "absent")
      throw new ConfigRejected(unsupportedLayout)
    expected = addToDocument(expected, addition)
  }
  let next: ConfigObject
  try {
    next = parseDocument(text, file.format)
  } catch {
    throw new ConfigRejected(unsupportedLayout)
  }
  if (!isDeepStrictEqual(expected, next))
    throw new ConfigRejected(unsupportedLayout)
  return text
}

function samePreimage(expected: ConfigFile, current: ConfigRead): boolean {
  if (
    current.kind !== "ready"
    || current.file.path !== expected.path
    || current.file.resolvedPath !== expected.resolvedPath
    || current.file.text !== expected.text
    || current.file.disk.kind !== expected.disk.kind
  )
    return false
  if (expected.disk.kind === "missing" || current.file.disk.kind === "missing")
    return true
  const first = expected.disk.metadata
  const second = current.file.disk.metadata
  return (
    first.dev === second.dev
    && first.ino === second.ino
    && first.mtimeNs === second.mtimeNs
    && first.mode === second.mode
    && first.size === second.size
  )
}

const ignorableChownErrors = new Set(["EPERM", "ENOSYS", "ENOTSUP", "EINVAL"])
const unsupportedLinkErrors = new Set(["EPERM", "ENOTSUP", "EXDEV", "ENOSYS"])

async function preserveOwnership(
  handle: FileHandle,
  metadata: BigIntStats,
): Promise<void> {
  const current = await handle.stat({ bigint: true })
  if (current.uid === metadata.uid && current.gid === metadata.gid) return
  try {
    await handle.chown(Number(metadata.uid), Number(metadata.gid))
  } catch (error) {
    if (!ignorableChownErrors.has(errorCode(error) ?? "")) throw error
  }
}

async function createExclusiveFile(
  path: string,
  text: string,
): Promise<"written" | "changed"> {
  let created: FileHandle
  try {
    created = await open(path, "wx", 0o600)
  } catch (error) {
    if (errorCode(error) === "EEXIST") return "changed"
    throw error
  }
  try {
    await created.writeFile(text, "utf8")
    await created.sync()
  } catch (error) {
    await created.close().catch(() => {})
    await rm(path, { force: true }).catch(() => {})
    throw error
  }
  await created.close()
  return "written"
}

async function publishNewFile(
  temporary: string,
  path: string,
  text: string,
): Promise<"written" | "changed"> {
  try {
    await link(temporary, path)
    return "written"
  } catch (error) {
    const code = errorCode(error)
    if (code === "EEXIST") return "changed"
    if (!unsupportedLinkErrors.has(code ?? "")) throw error
    return createExclusiveFile(path, text)
  }
}

async function commitAddition({
  file,
  text,
  target,
  homeDirectory,
}: {
  file: ConfigFile
  text: string
} & Pick<ConfigureMissingAgentOptions, "target" | "homeDirectory">): Promise<
  "written" | "changed"
> {
  await mkdir(dirname(file.resolvedPath), { recursive: true, mode: 0o700 })
  const mode =
    file.disk.kind === "existing" ?
      Number(file.disk.metadata.mode & 0o777n)
    : 0o600
  const temporary = join(
    dirname(file.resolvedPath),
    `.${basename(file.resolvedPath)}.${randomUUID()}.tmp`,
  )
  try {
    const handle = await open(temporary, "wx", mode)
    try {
      if (file.disk.kind === "existing") {
        await preserveOwnership(handle, file.disk.metadata)
        await handle.chmod(mode)
      }
      await handle.writeFile(text, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (!samePreimage(file, await readAgentConfig(target, homeDirectory)))
      return "changed"
    if (file.disk.kind === "missing")
      return await publishNewFile(temporary, file.resolvedPath, text)
    await rename(temporary, file.resolvedPath)
    return "written"
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function writeConfigAdditions(
  options: {
    file: ConfigFile
    additions: Array<Addition>
  } & Pick<ConfigureMissingAgentOptions, "target" | "homeDirectory">,
): Promise<
  { kind: "written" | "changed" } | { kind: "invalid"; message: string }
> {
  try {
    const text = prepareText(options.file, options.additions)
    return {
      kind: await commitAddition({
        file: options.file,
        text: text,
        target: options.target,
        homeDirectory: options.homeDirectory,
      }),
    }
  } catch (error) {
    return {
      kind: "invalid",
      message:
        error instanceof ConfigRejected ?
          error.message
        : "The configuration additions could not be saved.",
    }
  }
}
