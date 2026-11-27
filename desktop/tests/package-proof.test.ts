import { createPackage } from "@electron/asar"
import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { verifyPackage } from "../scripts/package-proof"

const directories: Array<string> = []

afterAll(async () => {
  for (const directory of directories)
    await fs.rm(directory, { recursive: true, force: true })
})

async function artifact(stale: boolean) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "copilot-proxy-package-proof-"),
  )
  directories.push(directory)
  const source = path.join(directory, "source")
  const packed = path.join(directory, "packed")
  const resources = path.join(directory, "app", "resources")
  const executable = path.join(directory, "app", "copilot-proxy")
  const files = {
    "main.cjs": "const githubApiVersion = '2022-11-28';\n",
    "preload.cjs": "preload\n",
    "renderer/index.html": "<title>Copilot Proxy</title>\n",
    "renderer/assets/app.js": "renderer\n",
  }
  await fs.mkdir(resources, { recursive: true })
  await fs.writeFile(executable, "native executable fixture\n")
  await fs.mkdir(source, { recursive: true })
  await fs.mkdir(packed, { recursive: true })
  await fs.writeFile(
    path.join(source, "package.json"),
    JSON.stringify({ name: "copilot-proxy", version: "0.0.2" }),
  )
  await fs.writeFile(
    path.join(packed, "package.json"),
    JSON.stringify(
      stale ?
        { name: "copilot-bridge", version: "0.0.1" }
      : { name: "copilot-proxy", version: "0.0.2" },
    ),
  )
  for (const [filename, bytes] of Object.entries(files)) {
    const sourceFile = path.join(source, "dist", filename)
    const packagedFile = path.join(packed, "dist", filename)
    await fs.mkdir(path.dirname(sourceFile), { recursive: true })
    await fs.mkdir(path.dirname(packagedFile), { recursive: true })
    await fs.writeFile(sourceFile, bytes)
    await fs.writeFile(
      packagedFile,
      stale && filename === "main.cjs" ?
        bytes.replace("2022-11-28", "2025-04-01")
      : bytes,
    )
  }
  await fs.writeFile(
    path.join(source, "dist", "engine.cjs"),
    "gateway engine\n",
  )
  if (stale) {
    await fs.writeFile(
      path.join(packed, "dist", "engine.cjs"),
      "gateway engine\n",
    )
    await fs.writeFile(
      path.join(packed, "dist", "renderer", "old.js"),
      "stale renderer\n",
    )
    await fs.writeFile(
      path.join(packed, "dist", "renderer", "assets", "old.js"),
      "stale nested renderer\n",
    )
  } else {
    const jsoncPackage = path.join(
      packed,
      "node_modules",
      "jsonc-parser",
      "package.json",
    )
    await fs.mkdir(path.dirname(jsoncPackage), { recursive: true })
    await fs.writeFile(jsoncPackage, '{"name":"jsonc-parser"}\n')
    const engine = path.join(
      resources,
      "app.asar.unpacked",
      "dist",
      "engine.cjs",
    )
    await fs.mkdir(path.dirname(engine), { recursive: true })
    await fs.writeFile(engine, "gateway engine\n")
    for (const dependency of ["pdf-parse", "pdfjs-dist"]) {
      const target = path.join(
        resources,
        "app.asar.unpacked",
        "node_modules",
        dependency,
        "package.json",
      )
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, `{"name":"${dependency}"}\n`)
    }
  }
  await createPackage(packed, path.join(resources, "app.asar"))
  return verifyPackage({
    sourceDirectory: source,
    executable,
    platform: "linux",
    productName: "Copilot Proxy",
  })
}

test("the packaged runtime and renderer match the fresh build", async () => {
  const report = await artifact(false)
  expect(report.passed).toBe(true)
  expect(report.issues).toEqual([])
  expect(report.files.map((file) => file.path).sort()).toEqual([
    "app.asar.unpacked/dist/engine.cjs",
    "dist/main.cjs",
    "dist/preload.cjs",
    "dist/renderer/assets/app.js",
    "dist/renderer/index.html",
  ])
  for (const file of report.files)
    expect(file.packagedSha256).toBe(file.sourceSha256)
})

test("a stale package fails when its header, renderer, metadata, runtime dependencies, or unpacked engine differs", async () => {
  const report = await artifact(true)
  expect(report.passed).toBe(false)
  expect(report.issues).toContain(
    "Packaged name or version does not match the source package.",
  )
  expect(report.issues).toContain(
    "Packaged file does not match the fresh build: dist/main.cjs",
  )
  expect(report.issues).toContain(
    "Packaged renderer contains a stale file: dist/renderer/old.js",
  )
  expect(report.issues).toContain(
    "Packaged renderer contains a stale file: dist/renderer/assets/old.js",
  )
  expect(report.issues).toContain(
    "Packaged file is missing or unreadable: app.asar.unpacked/dist/engine.cjs",
  )
  expect(report.issues).toContain(
    "Packaged runtime dependency is missing from app.asar: node_modules/jsonc-parser/package.json",
  )
  expect(report.issues).toContain(
    "Packaged unpacked dependency is missing or unreadable: app.asar.unpacked/node_modules/pdf-parse/package.json",
  )
  expect(report.issues).toContain(
    "Packaged unpacked dependency is missing or unreadable: app.asar.unpacked/node_modules/pdfjs-dist/package.json",
  )
})

test.skipIf(process.platform !== "darwin")(
  "macOS package verification checks CFBundleVersion against electron-builder.config.mjs",
  async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "copilot-proxy-macos-proof-"),
    )
    directories.push(directory)
    const source = path.join(directory, "source")
    const packed = path.join(directory, "packed")
    const contents = path.join(directory, "Copilot Proxy.app", "Contents")
    const resources = path.join(contents, "Resources")
    const executable = path.join(contents, "MacOS", "Copilot Proxy")
    await fs.mkdir(path.dirname(executable), { recursive: true })
    await fs.writeFile(executable, "native macos executable\n")
    await fs.mkdir(path.join(source, "dist", "renderer"), { recursive: true })
    await fs.mkdir(path.join(packed, "dist", "renderer"), { recursive: true })
    await fs.mkdir(path.join(packed, "node_modules", "jsonc-parser"), {
      recursive: true,
    })
    await fs.mkdir(resources, { recursive: true })
    await fs.writeFile(
      path.join(source, "package.json"),
      JSON.stringify({ name: "copilot-proxy", version: "0.0.8" }),
    )
    await fs.writeFile(
      path.join(source, "electron-builder.config.mjs"),
      'export default { buildVersion: "0.0.8.8", mac: { bundleVersion: "8" } }\n',
    )
    await fs.writeFile(
      path.join(packed, "package.json"),
      JSON.stringify({ name: "copilot-proxy", version: "0.0.8" }),
    )
    await fs.writeFile(
      path.join(packed, "node_modules", "jsonc-parser", "package.json"),
      '{"name":"jsonc-parser"}\n',
    )
    for (const filename of ["main.cjs", "preload.cjs", "renderer/index.html"]) {
      await fs.writeFile(path.join(source, "dist", filename), `${filename}\n`)
      await fs.writeFile(path.join(packed, "dist", filename), `${filename}\n`)
    }
    await fs.writeFile(path.join(source, "dist", "engine.cjs"), "engine\n")
    const unpackedEngine = path.join(
      resources,
      "app.asar.unpacked",
      "dist",
      "engine.cjs",
    )
    await fs.mkdir(path.dirname(unpackedEngine), { recursive: true })
    await fs.writeFile(unpackedEngine, "engine\n")
    for (const dependency of ["pdf-parse", "pdfjs-dist"]) {
      const target = path.join(
        resources,
        "app.asar.unpacked",
        "node_modules",
        dependency,
        "package.json",
      )
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, `{"name":"${dependency}"}\n`)
    }
    await createPackage(packed, path.join(resources, "app.asar"))

    const writePlist = (bundleVersion: string) =>
      fs.writeFile(
        path.join(contents, "Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Copilot Proxy</string>
<key>CFBundleDisplayName</key><string>Copilot Proxy</string>
<key>CFBundleShortVersionString</key><string>0.0.8</string>
<key>CFBundleVersion</key><string>${bundleVersion}</string>
</dict></plist>\n`,
      )

    await writePlist("8")
    const matching = await verifyPackage({
      sourceDirectory: source,
      executable,
      platform: "darwin",
      productName: "Copilot Proxy",
    })
    expect(matching.passed).toBe(true)
    expect(matching.issues).toEqual([])

    await writePlist("7")
    const mismatched = await verifyPackage({
      sourceDirectory: source,
      executable,
      platform: "darwin",
      productName: "Copilot Proxy",
    })
    expect(mismatched.passed).toBe(false)
    expect(mismatched.issues).toContain(
      "Native bundle build version does not match electron-builder.config.mjs.",
    )
  },
)
