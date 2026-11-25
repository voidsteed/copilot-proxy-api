import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { verifyPackage } from "./package-proof.ts"

type HostArchitecture = "arm64" | "x64"
type HostPlatform = "darwin" | "linux" | "win32"

interface PackageLayout {
  directories: Record<HostArchitecture, string>
  executable: Array<string>
}

const packageLayouts: Record<HostPlatform, PackageLayout> = {
  darwin: {
    directories: { arm64: "mac-arm64", x64: "mac" },
    executable: ["Copilot Proxy.app", "Contents", "MacOS", "Copilot Proxy"],
  },
  linux: {
    directories: { arm64: "linux-arm64-unpacked", x64: "linux-unpacked" },
    executable: ["copilot-proxy"],
  },
  win32: {
    directories: { arm64: "win-arm64-unpacked", x64: "win-unpacked" },
    executable: ["copilot-proxy.exe"],
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
  const verifyOnly = process.argv.includes("--verify-only")
  const platform = process.platform
  const architecture = process.arch
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32")
    throw new Error("Package smoke supports macOS, Windows, and Linux.")
  if (architecture !== "arm64" && architecture !== "x64")
    throw new Error(`Unsupported host architecture: ${architecture}`)
  if (verifyOnly && !process.env.COPILOT_PROXY_EXECUTABLE)
    throw new Error("--verify-only requires COPILOT_PROXY_EXECUTABLE.")

  const output =
    process.env.COPILOT_PROXY_PACKAGE_OUTPUT ?
      path.resolve(root, process.env.COPILOT_PROXY_PACKAGE_OUTPUT)
    : await fs.mkdtemp(path.join(os.tmpdir(), "copilot-proxy-package-"))
  const smokeOutput = path.resolve(
    root,
    process.env.COPILOT_PROXY_SMOKE_OUTPUT || path.join(output, "smoke"),
  )
  await fs.mkdir(output, { recursive: true })
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    COPILOT_PROXY_PACKAGE_OUTPUT: output,
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
  }
  delete environment.CSC_LINK
  delete environment.CSC_NAME
  delete environment.CSC_KEY_PASSWORD
  delete environment.WIN_CSC_LINK
  delete environment.WIN_CSC_KEY_PASSWORD
  const resolvePackage = createRequire(import.meta.url)
  const builderCli = resolvePackage.resolve("electron-builder/cli.js")
  if (!verifyOnly)
    process.stdout.write(
      `Packaging ${platform} ${architecture}. Output: ${output}\n`,
    )
  const packageCode =
    verifyOnly ? 0 : (
      await runNode({
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
    )
  if (packageCode !== 0) return packageCode

  const layout = packageLayouts[platform]
  const executable =
    process.env.COPILOT_PROXY_EXECUTABLE
    || path.join(output, layout.directories[architecture], ...layout.executable)
  const proof = await verifyPackage({
    sourceDirectory: root,
    executable,
    platform,
    productName: "Copilot Proxy",
  })
  await fs.mkdir(smokeOutput, { recursive: true })
  await fs.writeFile(
    path.join(smokeOutput, "package-proof.json"),
    JSON.stringify(proof, null, 2) + "\n",
  )
  if (!proof.passed) {
    process.stderr.write(proof.issues.join("\n") + "\n")
    return 1
  }
  process.stdout.write(
    `Packaged bytes match the fresh build. Evidence: ${smokeOutput}\n`,
  )
  if (verifyOnly) return 0
  process.stdout.write(`Testing packaged app: ${executable}\n`)
  return runNode({
    args: [path.join(root, "scripts", "smoke.ts")],
    environment: {
      ...environment,
      COPILOT_PROXY_EXECUTABLE: executable,
      COPILOT_PROXY_SMOKE_OUTPUT: smokeOutput,
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
