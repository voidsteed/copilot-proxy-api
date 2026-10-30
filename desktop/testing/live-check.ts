import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { z } from "zod"

import type { DesktopController } from "../main/types"

import { createController } from "../main/controller"
import { settingsSchema } from "../shared/contracts"
import { availablePort } from "./settings"

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("The live Copilot check timed out.")
}

async function createLiveController(
  output: string,
): Promise<DesktopController> {
  const directory = path.join(output, "user-data")
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  await fs.writeFile(
    path.join(directory, "settings.json"),
    JSON.stringify(
      settingsSchema.parse({
        port: await availablePort(),
        startOnLaunch: false,
      }),
    ),
  )
  const githubToken = (
    await fs.readFile(
      path.join(
        os.homedir(),
        ".local",
        "share",
        "copilot-proxy-api",
        "github_token",
      ),
      "utf8",
    )
  ).trim()
  if (!githubToken) throw new Error("No saved CLI Copilot sign-in was found.")
  const { randomBytes } = await import("node:crypto")
  return createController({
    dataDirectory: directory,
    runtimePath: path.join(__dirname, "engine.cjs"),
    platform: z.enum(["darwin", "win32", "linux"]).parse(process.platform),
    version: "0.0.1",
    vault: {
      mode: "session-only",
      load: () =>
        Promise.resolve({
          githubToken,
          gatewayKey: randomBytes(32).toString("base64url"),
        }),
      save: () => Promise.resolve(),
      clear: () => Promise.resolve(),
    },
    writeClipboard: () => undefined,
    openExternal: () => Promise.resolve(),
  })
}

async function main(): Promise<void> {
  if (!process.argv.includes("--use-cli-sign-in")) {
    throw new Error(
      "Pass --use-cli-sign-in to explicitly reuse the local CLI credential in memory.",
    )
  }
  const output =
    process.env.COPILOT_BRIDGE_LIVE_OUTPUT
    || (await fs.mkdtemp(path.join(os.tmpdir(), "copilot-bridge-live-")))
  const controller = await createLiveController(output)
  try {
    await waitFor(() => {
      const current = controller.snapshot()
      return (
        (current.account.kind === "signed-in"
          && current.modelsFetchedAt !== null)
        || current.account.kind === "error"
        || current.notice?.kind === "error"
      )
    })
    const snapshot = controller.snapshot()
    if (snapshot.fixture || snapshot.account.kind !== "signed-in") {
      throw new Error(
        snapshot.account.kind === "error" ?
          snapshot.account.message
        : "The saved sign-in could not authenticate with live GitHub Copilot.",
      )
    }
    const models = snapshot.models.filter(
      (model) =>
        model.endpoints.includes("/responses")
        || model.endpoints.includes("/chat/completions"),
    )
    const model =
      models.find((entry) => entry.id === "gpt-4.1")
      ?? models.find((entry) => /mini|flash/i.test(entry.id))
      ?? models.at(0)
    if (!model)
      throw new Error("This account has no compatible Copilot models.")
    await controller.invoke({ kind: "start-gateway" })
    await waitFor(() =>
      ["error", "running"].includes(controller.snapshot().gateway.kind),
    )
    if (controller.snapshot().gateway.kind !== "running")
      throw new Error("The live gateway could not start.")
    await controller.invoke({
      kind: "run-probe",
      modelId: model.id,
      prompt:
        "Reply with exactly this sentence and nothing else: Copilot Bridge is connected.",
    })
    await waitFor(() =>
      ["complete", "error"].includes(controller.snapshot().probe.kind),
    )
    const probe = controller.snapshot().probe
    if (
      probe.kind !== "complete"
      || !probe.text.includes("Copilot Bridge is connected.")
    ) {
      throw new Error(
        "The live model did not return the expected connection response.",
      )
    }
    const report = {
      passed: true,
      mode: "live",
      fixture: false,
      model: probe.model,
      response: probe.text,
      completedAt: new Date().toISOString(),
      persistedCredentials: false,
      scope:
        "Existing CLI sign-in reused in memory; no new GitHub device authorization",
    }
    await fs.writeFile(
      path.join(output, "live.json"),
      JSON.stringify(report, null, 2) + "\n",
    )
    process.stdout.write(
      `Live Copilot model ${probe.model} returned the expected response. Evidence: ${output}\n`,
    )
  } finally {
    await controller.dispose()
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Live Copilot check failed."}\n`,
  )
  process.exitCode = 1
})
