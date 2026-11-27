import { extractFile, listPackage, statFile, uncache } from "@electron/asar"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { z } from "zod"

const packageMetadataSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
})

const builderConfigSchema = z.object({
  buildVersion: z.string().min(1).optional(),
  mac: z
    .object({
      bundleVersion: z.string().min(1).optional(),
    })
    .optional(),
})

type PackageMetadata = z.infer<typeof packageMetadataSchema>
type HostPlatform = "darwin" | "linux" | "win32"

interface FileProof {
  path: string
  sourceSha256: string
  packagedSha256: string | null
}

export interface PackageProof {
  passed: boolean
  checkedAt: string
  executable: string
  sourceDirectory: string
  distDirectory: string
  expectedPackage: PackageMetadata
  packagedPackage: PackageMetadata | null
  files: Array<FileProof>
  issues: Array<string>
}

async function rendererFiles(directory: string): Promise<Array<string>> {
  const result: Array<string> = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) result.push(...(await rendererFiles(filename)))
    else if (entry.isFile()) result.push(filename)
    else
      throw new Error(`Build renderer contains an unexpected link: ${filename}`)
  }
  return result.sort()
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

async function compareFile(options: {
  source: string
  packaged(): Promise<Buffer>
  filename: string
  files: Array<FileProof>
  issues: Array<string>
}): Promise<void> {
  const source = await fs.readFile(options.source)
  let packaged: Buffer | null = null
  try {
    packaged = await options.packaged()
  } catch {
    options.issues.push(
      `Packaged file is missing or unreadable: ${options.filename}`,
    )
  }
  options.files.push({
    path: options.filename,
    sourceSha256: digest(source),
    packagedSha256: packaged && digest(packaged),
  })
  if (packaged && !source.equals(packaged))
    options.issues.push(
      `Packaged file does not match the fresh build: ${options.filename}`,
    )
}

async function resolveExpectedBundleVersion(options: {
  sourceDirectory: string
  explicit?: string
}): Promise<{ version: string | null; issue: string | null }> {
  if (options.explicit !== undefined)
    return { version: options.explicit, issue: null }
  const configPath = path.join(
    options.sourceDirectory,
    "electron-builder.config.mjs",
  )
  try {
    await fs.access(configPath)
  } catch {
    return { version: null, issue: null }
  }
  try {
    const imported: unknown = await import(
      `${pathToFileURL(configPath).href}?t=${Date.now()}`
    )
    const rawConfig =
      (
        typeof imported === "object"
        && imported !== null
        && "default" in imported
      ) ?
        imported.default
      : imported
    const config = builderConfigSchema.parse(rawConfig)
    const version = config.mac?.bundleVersion ?? config.buildVersion ?? null
    if (!version)
      return {
        version: null,
        issue:
          "Expected macOS bundle version is missing from electron-builder.config.mjs.",
      }
    return { version, issue: null }
  } catch {
    return {
      version: null,
      issue:
        "Expected macOS bundle version could not be read from electron-builder.config.mjs.",
    }
  }
}

async function checkNativeMetadata(options: {
  executable: string
  platform: HostPlatform
  productName: string
  name: string
  version: string
  expectedBundleVersion: string | null
  issues: Array<string>
}): Promise<void> {
  const expectedExecutable =
    options.platform === "darwin" ?
      options.productName
    : `${options.name}${options.platform === "win32" ? ".exe" : ""}`
  if (path.basename(options.executable) !== expectedExecutable)
    options.issues.push(
      "Native executable name does not match the source package.",
    )
  await fs.access(options.executable).catch(() => {
    options.issues.push("Native executable is missing or unreadable.")
  })
  if (options.platform !== "darwin") return
  try {
    const raw = execFileSync(
      "/usr/bin/plutil",
      [
        "-convert",
        "json",
        "-o",
        "-",
        path.join(path.dirname(path.dirname(options.executable)), "Info.plist"),
      ],
      { encoding: "utf8" },
    )
    const metadata = z
      .object({
        CFBundleName: z.string(),
        CFBundleDisplayName: z.string(),
        CFBundleShortVersionString: z.string(),
        CFBundleVersion: z.string(),
      })
      .parse(JSON.parse(raw))
    if (
      metadata.CFBundleName !== options.productName
      || metadata.CFBundleDisplayName !== options.productName
      || metadata.CFBundleShortVersionString !== options.version
    )
      options.issues.push(
        "Native bundle name or version does not match the source package.",
      )
    if (
      options.expectedBundleVersion !== null
      && metadata.CFBundleVersion !== options.expectedBundleVersion
    )
      options.issues.push(
        "Native bundle build version does not match electron-builder.config.mjs.",
      )
  } catch {
    options.issues.push("Native bundle metadata is missing or unreadable.")
  }
}

async function checkPackagedArchive(options: {
  archive: string
  dist: string
  expectedPackage: PackageMetadata
  filenames: Array<string>
  report: PackageProof
}): Promise<void> {
  const { archive, dist, expectedPackage, filenames, report } = options
  try {
    const entries = listPackage(archive, { isPack: false })
    const normalizedEntries = new Set(
      entries.map((entry) => entry.replaceAll("\\", "/").replace(/^\//, "")),
    )
    try {
      report.packagedPackage = packageMetadataSchema.parse(
        JSON.parse(extractFile(archive, "package.json").toString("utf8")),
      )
      if (
        report.packagedPackage.name !== expectedPackage.name
        || report.packagedPackage.version !== expectedPackage.version
      )
        report.issues.push(
          "Packaged name or version does not match the source package.",
        )
    } catch {
      report.issues.push("Packaged package.json is missing or invalid.")
    }
    for (const filename of filenames) {
      await compareFile({
        source: path.join(dist, filename),
        packaged: () =>
          Promise.resolve(extractFile(archive, path.join("dist", filename))),
        filename: `dist/${filename}`,
        files: report.files,
        issues: report.issues,
      })
    }
    if (!normalizedEntries.has("node_modules/jsonc-parser/package.json"))
      report.issues.push(
        "Packaged runtime dependency is missing from app.asar: node_modules/jsonc-parser/package.json",
      )
    for (const filename of normalizedEntries) {
      if (
        filename.startsWith("dist/renderer/")
        && !("files" in statFile(archive, path.normalize(filename), false))
        && !filenames.includes(filename.slice("dist/".length))
      )
        report.issues.push(
          `Packaged renderer contains a stale file: ${filename}`,
        )
    }
  } finally {
    uncache(archive)
  }
}

async function checkUnpackedRuntime(options: {
  resources: string
  dist: string
  files: Array<FileProof>
  issues: Array<string>
}): Promise<void> {
  await compareFile({
    source: path.join(options.dist, "engine.cjs"),
    packaged: () =>
      fs.readFile(
        path.join(options.resources, "app.asar.unpacked", "dist", "engine.cjs"),
      ),
    filename: "app.asar.unpacked/dist/engine.cjs",
    files: options.files,
    issues: options.issues,
  })
  for (const dependency of ["pdf-parse", "pdfjs-dist"]) {
    const target = path.join(
      options.resources,
      "app.asar.unpacked",
      "node_modules",
      dependency,
      "package.json",
    )
    await fs.access(target).catch(() => {
      options.issues.push(
        `Packaged unpacked dependency is missing or unreadable: app.asar.unpacked/node_modules/${dependency}/package.json`,
      )
    })
  }
}

export async function verifyPackage(options: {
  sourceDirectory: string
  executable: string
  platform: HostPlatform
  productName: string
  distDirectory?: string
  expectedBundleVersion?: string
}): Promise<PackageProof> {
  const dist =
    options.distDirectory ?? path.join(options.sourceDirectory, "dist")
  const resources =
    options.platform === "darwin" ?
      path.join(path.dirname(path.dirname(options.executable)), "Resources")
    : path.join(path.dirname(options.executable), "resources")
  const archive = path.join(resources, "app.asar")
  const expectedPackage = packageMetadataSchema.parse(
    JSON.parse(
      (
        await fs.readFile(path.join(options.sourceDirectory, "package.json"))
      ).toString("utf8"),
    ),
  )
  const report: PackageProof = {
    passed: false,
    checkedAt: new Date().toISOString(),
    executable: options.executable,
    sourceDirectory: options.sourceDirectory,
    distDirectory: dist,
    expectedPackage,
    packagedPackage: null,
    files: [],
    issues: [],
  }
  const renderer = await rendererFiles(path.join(dist, "renderer"))
  const filenames = [
    "main.cjs",
    "preload.cjs",
    ...renderer.map((filename) =>
      path.relative(dist, filename).split(path.sep).join("/"),
    ),
  ]
  await checkPackagedArchive({
    archive,
    dist,
    expectedPackage,
    filenames,
    report,
  })
  await checkUnpackedRuntime({
    resources,
    dist,
    files: report.files,
    issues: report.issues,
  })
  const bundleVersion =
    options.platform === "darwin" ?
      await resolveExpectedBundleVersion({
        sourceDirectory: options.sourceDirectory,
        explicit: options.expectedBundleVersion,
      })
    : { version: null, issue: null }
  if (bundleVersion.issue) report.issues.push(bundleVersion.issue)
  await checkNativeMetadata({
    ...options,
    ...expectedPackage,
    expectedBundleVersion: bundleVersion.version,
    issues: report.issues,
  })
  report.passed = report.issues.length === 0
  return report
}
