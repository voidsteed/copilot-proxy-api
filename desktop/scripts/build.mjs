import { build } from "esbuild"
import { mkdir, lstat, realpath, symlink } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { build as buildRenderer } from "vite"

const root = fileURLToPath(new URL("..", import.meta.url))
const output = path.join(root, "dist")
await mkdir(output, { recursive: true })
const dependencies = await realpath(path.join(root, "node_modules"))
const runtimeDependencies = path.join(output, "node_modules")
try {
  await lstat(runtimeDependencies)
  if ((await realpath(runtimeDependencies)) !== dependencies) {
    throw new Error("Build output has an unexpected dependency directory.")
  }
} catch (error) {
  if (
    !(error instanceof Error)
    || !("code" in error)
    || error.code !== "ENOENT"
  )
    throw error
  await symlink(
    dependencies,
    runtimeDependencies,
    process.platform === "win32" ? "junction" : "dir",
  )
}

await build({
  absWorkingDir: root,
  entryPoints: {
    main: "main/index.ts",
    preload: "main/preload.ts",
    engine: "engine/index.ts",
    preview: "testing/preview-entry.ts",
    "live-check": "testing/live-check.ts",
  },
  outdir: output,
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  alias: { "~": path.resolve(root, "../src") },
  external: ["electron", "pdf-parse"],
  sourcemap: true,
  logLevel: "info",
})

await buildRenderer({ configFile: path.join(root, "vite.config.ts") })
