import { build } from "esbuild"
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
} from "node:fs/promises"
import path from "node:path"

const root = import.meta.dirname
const output = path.join(root, "dist")
await mkdir(output, { recursive: true })
const dependencies = await realpath(path.join(root, "node_modules"))
const runtimeDependencies = path.join(output, "node_modules")
let linkDependencies = false
try {
  const stats = await lstat(runtimeDependencies)
  if (stats.isSymbolicLink()) {
    const resolved = await realpath(runtimeDependencies).catch(() => null)
    if (resolved !== dependencies) {
      await unlink(runtimeDependencies)
      linkDependencies = true
    }
  } else if ((await realpath(runtimeDependencies)) !== dependencies) {
    throw new Error("Build output has an unexpected dependency directory.")
  }
} catch (error) {
  if (
    !(error instanceof Error)
    || !("code" in error)
    || error.code !== "ENOENT"
  )
    throw error
  linkDependencies = true
}
if (linkDependencies) {
  await symlink(
    dependencies,
    runtimeDependencies,
    process.platform === "win32" ? "junction" : "dir",
  )
}

for (const entry of await readdir(output, { withFileTypes: true })) {
  if (
    entry.isFile()
    && (entry.name.endsWith(".cjs") || entry.name.endsWith(".cjs.map"))
  ) {
    await rm(path.join(output, entry.name), { force: true })
  }
}

await build({
  absWorkingDir: root,
  entryPoints: {
    engine: "engine/index.ts",
    bridge: "index.ts",
  },
  outdir: output,
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  alias: { "~": path.resolve(root, "../../src") },
  external: ["pdf-parse", "jsonc-parser"],
  sourcemap: true,
  logLevel: "info",
})
