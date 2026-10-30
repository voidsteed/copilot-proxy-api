import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createController } from "../main/controller"
import { createCredentialVault } from "../main/vault"
import { startPreviewServer } from "./preview"
import { isolateFixturePort } from "./settings"
import { startFixtureUpstream } from "./upstream"

function hostPlatform(): "darwin" | "win32" | "linux" {
  if (process.platform === "darwin" || process.platform === "win32")
    return process.platform
  return "linux"
}

async function copy(text: string): Promise<void> {
  const commands = {
    darwin: { executable: "pbcopy", args: [] },
    win32: {
      executable: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$input | Set-Clipboard",
      ],
    },
    linux: { executable: "xclip", args: ["-selection", "clipboard"] },
  }
  const { executable, args } = commands[hostPlatform()]
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ["pipe", "ignore", "ignore"],
    })
    child.once("error", () =>
      reject(new Error("The preview could not access the system clipboard.")),
    )
    child.once("exit", (code) =>
      code === 0 ? resolve() : (
        reject(new Error("The preview could not access the system clipboard."))
      ),
    )
    child.stdin.end(text)
  })
}

async function main(): Promise<void> {
  const directory =
    process.env.COPILOT_BRIDGE_PREVIEW_DATA
    || (await fs.mkdtemp(path.join(os.tmpdir(), "copilot-bridge-preview-")))
  const fixture = await startFixtureUpstream()
  const controller = await createController({
    dataDirectory: directory,
    runtimePath: path.join(__dirname, "engine.cjs"),
    fixtureOrigin: fixture.origin,
    platform: hostPlatform(),
    version: "0.0.1",
    vault: createCredentialVault({ directory, encryption: null }),
    writeClipboard: copy,
    openExternal: () => Promise.resolve(),
    applyLoginItem: () => Promise.resolve(),
  })
  await isolateFixturePort(controller)
  const port = Number(process.env.COPILOT_BRIDGE_PREVIEW_PORT || "5174")
  const server = await startPreviewServer({
    controller,
    rendererDirectory: path.join(__dirname, "renderer"),
    port,
  })
  process.stdout.write(`Copilot Bridge fixture preview: ${server.origin}\n`)
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    await controller.dispose()
    await server.close()
    await fixture.close()
  }
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      void close().then(() => process.exit())
    })
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Preview could not start."}\n`,
  )
  process.exitCode = 1
})
