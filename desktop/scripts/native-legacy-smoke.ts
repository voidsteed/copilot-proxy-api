import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"

import { cliProxyOptions, openProxySession } from "../../src/lib/proxy-session"
import { startSmokeLegacyProxy } from "../testing/smoke-fixtures"

function parseNativeReport(raw: string) {
  const report: unknown = JSON.parse(raw)
  return z
    .object({
      passed: z.literal(true),
      mode: z.literal("legacy-fixture"),
      checks: z.array(z.string()).min(6),
    })
    .parse(report)
}

async function seedLegacyConfiguration(options: {
  homeDirectory: string
  rootUrl: string
  apiUrl: string
}): Promise<void> {
  const claudeFolder = path.join(options.homeDirectory, ".claude")
  const codexFolder = path.join(options.homeDirectory, ".codex")
  await fs.mkdir(claudeFolder, { recursive: true })
  await fs.mkdir(codexFolder, { recursive: true })
  await fs.writeFile(
    path.join(claudeFolder, "settings.json"),
    `{
  // Preserve the independently configured Claude alias.
  "env": {
    "ANTHROPIC_BASE_URL": ${JSON.stringify(options.rootUrl)},
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_MODEL": "fixture-legacy-claude[1m]"
  },
  "permissions": { "allow": ["Read"], "deny": [] }
}
`,
    { flag: "wx", mode: 0o600 },
  )
  await fs.writeFile(
    path.join(codexFolder, "config.toml"),
    `# Preserve the independent Codex model and provider.
model = "fixture-legacy-responses"
model_provider = "copilot_proxy"

[model_providers.copilot_proxy]
name = "Legacy proxy"
base_url = ${JSON.stringify(options.apiUrl)}
wire_api = "responses"

[mcp_servers.local]
command = "fixture-mcp"
`,
    { flag: "wx", mode: 0o600 },
  )
}

async function runNative(options: {
  executable: string
  homeDirectory: string
  stateDirectory: string
  outputDirectory: string
}): Promise<Array<string>> {
  const log = await fs.open(
    path.join(options.outputDirectory, "electron.log"),
    "w",
  )
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const child = spawn(
    options.executable,
    [
      "--fixture",
      "--data-dir",
      options.homeDirectory,
      "--state-dir",
      options.stateDirectory,
      "--smoke-output",
      options.outputDirectory,
      "--legacy-native-smoke",
    ],
    { env: environment, stdio: ["ignore", "pipe", "pipe"] },
  )
  let writes = Promise.resolve()
  const write = (input: unknown) => {
    assert(Buffer.isBuffer(input))
    writes = writes.then(async () => {
      await log.write(input)
    })
  }
  child.stdout.on("data", write)
  child.stderr.on("data", write)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, 120_000)
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", resolve)
    })
    assert(!timedOut, "The isolated legacy native app exceeded 120 seconds")
    const failure = await fs
      .readFile(path.join(options.outputDirectory, "failure.txt"), "utf8")
      .catch(() => "See electron.log")
    assert.equal(code, 0, failure)
    const parsed = parseNativeReport(
      await fs.readFile(
        path.join(options.outputDirectory, "smoke.json"),
        "utf8",
      ),
    )
    return parsed.checks
  } finally {
    clearTimeout(timer)
    await writes
    await log.close()
  }
}

async function verifyTerminalBeforeNative(options: {
  homeDirectory: string
  stateDirectory: string
  outputDirectory: string
}): Promise<void> {
  const terminal = await openProxySession({
    ...(await cliProxyOptions(options)),
    intent: {
      kind: "ensure-running",
      explicit: {},
      credential: { kind: "native-saved-account" },
    },
  })
  assert(terminal.kind === "legacy")
  try {
    const snapshot = await terminal.read()
    assert(
      snapshot.activity.some((record) =>
        record.id.includes("legacy-inference-1"),
      ),
    )
    await fs.writeFile(
      path.join(options.outputDirectory, "cli-first.json"),
      JSON.stringify(snapshot, null, 2) + "\n",
    )
  } finally {
    await terminal.release()
  }
}

async function main(): Promise<void> {
  assert.equal(
    process.platform,
    "darwin",
    "This native legacy verification runs on Mac",
  )
  const executable = process.env.COPILOT_PROXY_EXECUTABLE
  const requestedOutput = process.env.COPILOT_PROXY_SMOKE_OUTPUT
  assert(
    executable && requestedOutput,
    "Set the packaged executable and an isolated SSD evidence directory",
  )
  const outputDirectory = path.resolve(requestedOutput)
  assert(
    outputDirectory.startsWith("/Volumes/mac-ssd/AI/projects/"),
    "Native evidence must stay on the mounted mac-ssd project root",
  )
  assert.notEqual(
    (await fs.stat("/Volumes/mac-ssd")).dev,
    (await fs.stat("/")).dev,
    "mac-ssd is a separate mounted volume",
  )
  const homeDirectory = path.join(outputDirectory, "user-data")
  const stateDirectory = path.join(homeDirectory, "native")
  const nativeOutput = path.join(outputDirectory, "native")
  await fs.mkdir(nativeOutput, { recursive: true })
  const legacy = await startSmokeLegacyProxy()
  try {
    await seedLegacyConfiguration({ homeDirectory, ...legacy.connection })
    const inference = await fetch(`${legacy.connection.apiUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "fixture-legacy-responses",
        input: "Terminal before native startup",
      }),
    })
    assert.equal(inference.status, 200)
    await inference.text()
    await verifyTerminalBeforeNative({
      homeDirectory,
      stateDirectory,
      outputDirectory,
    })
    const checks = await runNative({
      executable,
      homeDirectory,
      stateDirectory,
      outputDirectory: nativeOutput,
    })
    assert.equal(
      await (await fetch(legacy.connection.rootUrl)).text(),
      "Server running",
    )
    const afterQuit = await fetch(`${legacy.connection.apiUrl}/responses`, {
      method: "POST",
      body: "{}",
    })
    assert.equal(afterQuit.status, 200)
    await afterQuit.text()
    await fs.writeFile(
      path.join(outputDirectory, "lifecycle.json"),
      JSON.stringify(
        {
          passed: true,
          platform: process.platform,
          checks,
          cliSurvivedObserverReleaseAndNativeQuit: true,
          externalListenerProcessId: process.pid,
          methods: [...new Set(legacy.methods)],
          limitations: [
            "Faithful legacy HTTP fixture; encrypted account recovery and live Copilot inference are verified separately",
          ],
        },
        null,
        2,
      ) + "\n",
    )
    process.stdout.write(
      `${checks.length} native legacy workflows passed. Evidence: ${outputDirectory}\n`,
    )
  } finally {
    await legacy.close()
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Native legacy verification failed."}\n`,
  )
  process.exitCode = 1
})
