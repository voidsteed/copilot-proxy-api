import { Database } from "bun:sqlite"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { state } from "~/lib/state"
import { server } from "~/server"

// Uses an already authenticated proxy only to obtain in-memory credentials.
// The actual Codex requests exercise this checkout's Hono routes over HTTP.
const sourceUrl = process.env.COPILOT_PROXY_URL ?? "http://localhost:4141"
const model = process.env.CODEX_SMOKE_MODEL ?? "gpt-6.1-sol"
const tokenResponse = await fetch(`${sourceUrl}/token`)
if (!tokenResponse.ok) throw new Error("Cannot obtain local proxy credentials")
const token = (await tokenResponse.json()) as { token?: string }
if (!token.token) throw new Error("Start an authenticated proxy first")
state.copilotToken = token.token
state.accountType = process.env.COPILOT_ACCOUNT_TYPE ?? "individual"
state.vsCodeVersion = "1.112.0"
const models = await fetch(`${sourceUrl}/v1/models`)
const catalog = (await models.json()) as {
  data: NonNullable<typeof state.models>["data"]
}
state.models = { object: "list", data: catalog.data }
const local = Bun.serve({ port: 0, idleTimeout: 0, fetch: server.fetch })
const directory = await mkdtemp(path.join(tmpdir(), "codex-smoke-"))
const image = path.resolve(import.meta.dir, "../docs/assets/social-preview.png")
const common = [
  "--skip-git-repo-check",
  "--json",
  "--sandbox",
  "read-only",
  "-C",
  directory,
  "-c",
  'model_provider="copilot_proxy"',
  "-c",
  `model=${JSON.stringify(model)}`,
  "-c",
  'model_reasoning_effort="low"',
  "-c",
  'model_providers.copilot_proxy.name="Copilot smoke test"',
  "-c",
  `model_providers.copilot_proxy.base_url="http://localhost:${local.port}/v1"`,
  "-c",
  'model_providers.copilot_proxy.wire_api="responses"',
]

async function run(
  args: Array<string>,
): Promise<Array<Record<string, unknown>>> {
  const child = Bun.spawn([process.env.CODEX_BIN ?? "codex", "exec", ...args], {
    env: { ...process.env, CODEX_HOME: directory },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 120000)
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (exit !== 0)
      throw new Error(`Codex smoke failed (${exit}): ${stderr}\n${stdout}`)
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  } finally {
    clearTimeout(timer)
  }
}

try {
  await writeFile(path.join(directory, "fixture.txt"), "copilot-tool-ok\n")
  const first = await run([
    ...common,
    "Read fixture.txt using a shell tool. Reply with exactly its contents. Do not edit files.",
  ])
  if (!JSON.stringify(first).includes("copilot-tool-ok"))
    throw new Error("Missing tool result")
  if (!JSON.stringify(first).includes("command_execution"))
    throw new Error("Codex did not execute a tool")
  const thread = first.find(
    (event) => event.type === "thread.started",
  )?.thread_id
  if (typeof thread !== "string") throw new Error("Missing resumable thread")
  console.log("PASS: Codex text and tool call/result")
  const resumed = await run([
    ...common,
    "resume",
    thread,
    "What was the contents of fixture.txt from the previous turn? Reply with exactly that value without tools.",
  ])
  if (!JSON.stringify(resumed).includes("copilot-tool-ok"))
    throw new Error("Resume lost history")
  console.log("PASS: Codex resumed history")
  const vision = await run([
    ...common,
    "--ephemeral",
    "-i",
    image,
    "--",
    "Read the title in this image. Reply with the title only.",
  ])
  if (!/copilot/i.test(JSON.stringify(vision)))
    throw new Error("Image title was not recognized")
  console.log("PASS: Codex image input")
  const logsPath = path.join(directory, "logs_2.sqlite")
  if (await Bun.file(logsPath).exists()) {
    // Older Desktop bundles leave WAL databases without shared-memory files;
    // SQLite needs write access to create those in this isolated test directory.
    const logs = new Database(logsPath)
    try {
      const mismatch = logs
        .query(
          "SELECT count(*) AS count FROM logs WHERE feedback_log_body LIKE '%item completed without a recorded start timestamp%'",
        )
        .get() as { count: number }
      if (mismatch.count > 0)
        throw new Error(
          `Codex reported ${mismatch.count} item lifecycle warnings`,
        )
      console.log("PASS: Codex logs contain no item identity mismatch warnings")
    } finally {
      logs.close()
    }
  }
  const cancellation = new AbortController()
  const pending = fetch(`http://localhost:${local.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: true, input: "Say hello" }),
    signal: cancellation.signal,
  })
  cancellation.abort()
  try {
    await pending
    throw new Error("Cancellation did not reject")
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "AbortError")
      throw error
  }
  console.log(
    "PASS: HTTP client cancellation (upstream propagation covered by regression tests)",
  )
} finally {
  await local.stop(true)
  await rm(directory, { recursive: true, force: true })
}
