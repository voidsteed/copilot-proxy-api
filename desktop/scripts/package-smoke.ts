import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

type HostArchitecture = "arm64" | "x64"
type HostPlatform = "darwin" | "linux" | "win32"

interface PackageLayout {
  directories: Record<HostArchitecture, string>
  executable: Array<string>
}

const packageLayouts: Record<HostPlatform, PackageLayout> = {
  darwin: {
    directories: { arm64: "mac-arm64", x64: "mac" },
    executable: ["Copilot Bridge.app", "Contents", "MacOS", "Copilot Bridge"],
  },
  linux: {
    directories: { arm64: "linux-arm64-unpacked", x64: "linux-unpacked" },
    executable: ["copilot-bridge"],
  },
  win32: {
    directories: { arm64: "win-arm64-unpacked", x64: "win-unpacked" },
    executable: ["copilot-bridge.exe"],
  },
}

const root = fileURLToPath(new URL("..", import.meta.url))

async function runNode({
  args,
  environment,
}: {
  args: Array<string>
  environment: NodeJS.ProcessEnv
}): Promise<number> {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: environment,
    stdio: "inherit",
  })
  return new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (signal) process.stderr.write(`Process ended with ${signal}.\n`)
      resolve(code ?? 1)
    })
  })
}

async function main(): Promise<number> {
  const platform = process.platform
  const architecture = process.arch
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32")
    throw new Error("Package smoke supports macOS, Windows, and Linux.")
  if (architecture !== "arm64" && architecture !== "x64")
    throw new Error(`Unsupported host architecture: ${architecture}`)

  const output =
    process.env.COPILOT_BRIDGE_PACKAGE_OUTPUT ?
      path.resolve(root, process.env.COPILOT_BRIDGE_PACKAGE_OUTPUT)
    : await fs.mkdtemp(path.join(os.tmpdir(), "copilot-bridge-package-"))
  const smokeOutput = path.resolve(
    root,
    process.env.COPILOT_BRIDGE_SMOKE_OUTPUT || path.join(output, "smoke"),
  )
  await fs.mkdir(output, { recursive: true })
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    COPILOT_BRIDGE_PACKAGE_OUTPUT: output,
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
  }
  delete environment.CSC_LINK
  delete environment.CSC_NAME
  delete environment.CSC_KEY_PASSWORD
  delete environment.WIN_CSC_LINK
  delete environment.WIN_CSC_KEY_PASSWORD
  const resolvePackage = createRequire(import.meta.url)
  const builderCli = resolvePackage.resolve("electron-builder/cli.js")
  process.stdout.write(
    `Packaging ${platform} ${architecture}. Output: ${output}\n`,
  )
  const packageCode = await runNode({
    args: [
      builderCli,
      "--config",
      path.join(root, "electron-builder.config.mjs"),
      "--dir",
      `--${architecture}`,
      "--publish",
      "never",
    ],
    environment,
  })
  if (packageCode !== 0) return packageCode

  const layout = packageLayouts[platform]
  const executable = path.join(
    output,
    layout.directories[architecture],
    ...layout.executable,
  )
  await fs.access(executable)
  process.stdout.write(`Testing packaged app: ${executable}\n`)
  return runNode({
    args: [path.join(root, "scripts", "smoke.ts")],
    environment: {
      ...environment,
      COPILOT_BRIDGE_EXECUTABLE: executable,
      COPILOT_BRIDGE_SMOKE_OUTPUT: smokeOutput,
    },
  })
}

const exitCode = await main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Package smoke failed."}\n`,
  )
  return 1
})
process.exitCode = exitCode
