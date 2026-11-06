import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

import { electronExecutable } from "./electron-path.ts"

function parseReport(raw: string) {
  const parsed: unknown = JSON.parse(raw)
  return z
    .object({ passed: z.boolean(), checks: z.array(z.string()) })
    .parse(parsed)
}

const root = fileURLToPath(new URL("..", import.meta.url))
const output =
  process.env.COPILOT_PROXY_SMOKE_OUTPUT
  || (await fs.mkdtemp(path.join(os.tmpdir(), "copilot-proxy-smoke-")))
const data = path.join(output, "user-data")
await fs.mkdir(output, { recursive: true })
const executable = process.env.COPILOT_PROXY_EXECUTABLE || electronExecutable
const packaged = Boolean(process.env.COPILOT_PROXY_EXECUTABLE)
const args = [
  ...(!packaged ? [root] : []),
  "--fixture",
  ...(process.argv.includes("--default-fixture-profile") ?
    []
  : ["--data-dir", data]),
  "--smoke-output",
  output,
  ...(process.env.CI && process.platform === "linux" ?
    ["--no-sandbox", "--disable-gpu"]
  : []),
]
const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE
const child = spawn(executable, args, {
  cwd: root,
  env: environment,
  stdio: ["ignore", "pipe", "pipe"],
})
const startedAt = Date.now()
const log = await fs.open(path.join(output, "electron.log"), "w")
child.stdout.on("data", (chunk) => {
  void log.write(chunk)
})
child.stderr.on("data", (chunk) => {
  void log.write(chunk)
})
let timedOut = false
const timer = setTimeout(() => {
  timedOut = true
  child.kill("SIGKILL")
}, 120_000)
try {
  const status = await new Promise<{
    code: number | null
    signal: NodeJS.Signals | null
  }>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve({ code, signal }))
  })
  await fs.writeFile(
    path.join(output, "process-status.json"),
    JSON.stringify(
      { ...status, timedOut, elapsedMs: Date.now() - startedAt },
      null,
      2,
    ) + "\n",
  )
  assert(!timedOut, "Native smoke exceeded 120 seconds")
  assert.equal(
    status.code,
    0,
    `Electron exited with code ${status.code} and signal ${status.signal}`,
  )
  const report = parseReport(
    await fs.readFile(path.join(output, "smoke.json"), "utf8"),
  )
  assert.equal(report.passed, true)
  process.stdout.write(
    `${report.checks.length} native workflows passed. Evidence: ${output}\n`,
  )
} catch {
  const failure = await fs
    .readFile(path.join(output, "failure.txt"), "utf8")
    .catch(() => "See electron.log and native-failure.png")
  process.stderr.write(`${failure}\nEvidence: ${output}\n`)
  process.exitCode = 1
} finally {
  clearTimeout(timer)
  await log.close()
}
