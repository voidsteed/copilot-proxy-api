import { extractFile, listPackage, statFile, uncache } from "@electron/asar"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"

const packageMetadataSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
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

async function checkNativeMetadata(options: {
  executable: string
  platform: HostPlatform
  productName: string
  name: string
  version: string
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
  } catch {
    options.issues.push("Native bundle metadata is missing or unreadable.")
  }
}

export async function verifyPackage(options: {
  sourceDirectory: string
  executable: string
  platform: HostPlatform
  productName: string
  distDirectory?: string
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
  try {
    const entries = listPackage(archive, { isPack: false })
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
          Promise.resolve(extractFile(archive, `dist/${filename}`)),
        filename: `dist/${filename}`,
        files: report.files,
        issues: report.issues,
      })
    }
    for (const entry of entries) {
      const filename = entry.replaceAll("\\", "/").replace(/^\//, "")
      if (
        filename.startsWith("dist/renderer/")
        && !("files" in statFile(archive, filename, false))
        && !filenames.includes(filename.slice("dist/".length))
      )
        report.issues.push(
          `Packaged renderer contains a stale file: ${filename}`,
        )
    }
  } finally {
    uncache(archive)
  }
  await compareFile({
    source: path.join(dist, "engine.cjs"),
    packaged: () =>
      fs.readFile(
        path.join(resources, "app.asar.unpacked", "dist", "engine.cjs"),
      ),
    filename: "app.asar.unpacked/dist/engine.cjs",
    files: report.files,
    issues: report.issues,
  })
  await checkNativeMetadata({
    ...options,
    ...expectedPackage,
    issues: report.issues,
  })
  report.passed = report.issues.length === 0
  return report
}
