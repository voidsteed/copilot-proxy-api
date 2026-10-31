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
  } else {
    const engine = path.join(
      resources,
      "app.asar.unpacked",
      "dist",
      "engine.cjs",
    )
    await fs.mkdir(path.dirname(engine), { recursive: true })
    await fs.writeFile(engine, "gateway engine\n")
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
  expect(report.files).toHaveLength(5)
  for (const file of report.files)
    expect(file.packagedSha256).toBe(file.sourceSha256)
})

test("a stale package fails when its header, renderer, metadata, or unpacked engine differs", async () => {
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
    "Packaged file is missing or unreadable: app.asar.unpacked/dist/engine.cjs",
  )
})
