import { Database } from "bun:sqlite"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { state } from "~/lib/state"
import { server } from "~/server"

interface CompletedItem {
  id: string
  type: string
  text?: string
}

async function assertNoLifecycleWarningsInLogs(
  directory: string,
): Promise<void> {
  const entries = await readdir(directory)
  for (const entry of entries) {
    if (!/^logs_.*\.sqlite$/.test(entry)) continue
    // Open read-write so SQLite can recover WAL databases lacking -shm files.
    const logs = new Database(path.join(directory, entry))
    try {
      const mismatch = logs
        .query(
          "SELECT count(*) AS count FROM logs WHERE feedback_log_body LIKE '%item completed without a recorded start timestamp%'",
        )
        .get() as { count: number }
      if (mismatch.count > 0) {
        throw new Error(
          `Desktop logs (${entry}) reported ${mismatch.count} item lifecycle warnings`,
        )
      }
    } finally {
      logs.close()
    }
  }
}

const source = process.env.COPILOT_PROXY_URL ?? "http://localhost:4141"
const model = process.env.CODEX_SMOKE_MODEL ?? "gpt-6.1-sol"
const tokenResponse = await fetch(`${source}/token`)
if (!tokenResponse.ok) throw new Error("Cannot obtain local proxy credentials")
const token = (await tokenResponse.json()) as { token?: string }
if (!token.token) throw new Error("Start an authenticated proxy first")
state.copilotToken = token.token
state.accountType = process.env.COPILOT_ACCOUNT_TYPE ?? "individual"
state.vsCodeVersion = "1.112.0"
const modelsResponse = await fetch(`${source}/v1/models`)
if (!modelsResponse.ok) throw new Error("Cannot obtain local proxy models")
const catalog = (await modelsResponse.json()) as {
  data: NonNullable<typeof state.models>["data"]
}
state.models = { object: "list", data: catalog.data }

const local = Bun.serve({ port: 0, idleTimeout: 0, fetch: server.fetch })
const directory = await mkdtemp(path.join(tmpdir(), "codex-desktop-smoke-"))
let stderr = ""

try {
  const child = Bun.spawn(
    [
      process.env.CODEX_BIN
        ?? "/Applications/Codex.app/Contents/Resources/codex",
      "app-server",
      "-c",
      'model_provider="copilot_proxy"',
      "-c",
      `model=${JSON.stringify(model)}`,
      "-c",
      'model_providers.copilot_proxy.name="Desktop smoke"',
      "-c",
      `model_providers.copilot_proxy.base_url="http://localhost:${local.port}/v1"`,
      "-c",
      'model_providers.copilot_proxy.wire_api="responses"',
    ],
    {
      env: { ...process.env, CODEX_HOME: directory },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const pending = new Map<
    number,
    {
      resolve(value: Record<string, unknown>): void
      reject(error: Error): void
    }
  >()
  const notifications: Array<Record<string, unknown>> = []
  let nextId = 0
  let readerError: Error | undefined
  const stderrTask = new Response(child.stderr).text().then((text) => {
    stderr = text
  })

  function handleLine(line: string): void {
    if (line.length === 0) return
    const value = JSON.parse(line) as Record<string, unknown>
    const request =
      typeof value.id === "number" ? pending.get(value.id) : undefined
    if (request) {
      pending.delete(value.id as number)
      if (value.error) request.reject(new Error(JSON.stringify(value.error)))
      else request.resolve(value.result as Record<string, unknown>)
    } else {
      notifications.push(value)
    }
  }

  const readerTask = (async () => {
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      for await (const chunk of child.stdout) {
        buffer += decoder.decode(chunk, { stream: true })
        let newline = buffer.indexOf("\n")
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          handleLine(line)
          newline = buffer.indexOf("\n")
        }
      }
      handleLine((buffer + decoder.decode()).trim())
    } catch (error) {
      readerError = error instanceof Error ? error : new Error(String(error))
    } finally {
      const closeError =
        readerError ?? new Error("Desktop app-server stdout closed")
      for (const request of pending.values()) {
        request.reject(closeError)
      }
      pending.clear()
    }
  })()

  async function rpc(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const id = ++nextId
    const result = new Promise<Record<string, unknown>>((resolve, reject) =>
      pending.set(id, { resolve, reject }),
    )
    try {
      await child.stdin.write(JSON.stringify({ id, method, params }) + "\n")
      await child.stdin.flush()
    } catch (error) {
      pending.delete(id)
      throw error
    }
    return result
  }

  async function turn(
    threadId: string,
    prompt: string,
    expectedText: string,
  ): Promise<void> {
    notifications.length = 0
    await rpc("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt }],
      effort: "high",
    })
    const turnDeadline = Date.now() + 90000
    while (!notifications.some((event) => event.method === "turn/completed")) {
      if (readerError) throw readerError
      if (notifications.some((event) => event.method === "error")) {
        throw new Error(`Desktop turn failed: ${JSON.stringify(notifications)}`)
      }
      if (child.exitCode !== null) {
        throw new Error(
          `Desktop app-server exited early (${child.exitCode}): ${stderr}`,
        )
      }
      if (Date.now() > turnDeadline) throw new Error("Desktop turn timed out")
      await Bun.sleep(50)
    }
    if (notifications.some((event) => event.method === "error")) {
      throw new Error(`Desktop turn failed: ${JSON.stringify(notifications)}`)
    }
    const startedIds = new Set(
      notifications
        .filter((event) => event.method === "item/started")
        .map((event) => (event.params as { item: { id: string } }).item.id),
    )
    const completedItems = notifications
      .filter((event) => event.method === "item/completed")
      .map((event) => (event.params as { item: CompletedItem }).item)
    for (const item of completedItems) {
      if (
        (item.type === "agentMessage" || item.type === "reasoning")
        && !startedIds.has(item.id)
      ) {
        throw new Error("Desktop item completed without a matching start")
      }
    }
    const agentMessages = completedItems.filter(
      (item) => item.type === "agentMessage",
    )
    if (agentMessages.length === 0) {
      throw new Error(
        `Missing completed agentMessage: ${JSON.stringify(notifications)}`,
      )
    }
    if (
      !agentMessages.some(
        (item) =>
          typeof item.text === "string" && item.text.includes(expectedText),
      )
    ) {
      throw new Error(
        `Missing Desktop answer "${expectedText}" in agentMessage: ${JSON.stringify(agentMessages)}`,
      )
    }
  }

  const deadline = setTimeout(() => child.kill(), 180000)
  try {
    await rpc("initialize", {
      clientInfo: { name: "copilot_desktop_smoke", version: "1.0" },
      capabilities: { experimentalApi: true },
    })
    await child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n")
    await child.stdin.flush()
    const result = await rpc("thread/start", {
      model,
      modelProvider: "copilot_proxy",
      cwd: directory,
      approvalPolicy: "never",
      sandbox: "read-only",
    })
    const thread = result.thread as { id?: string }
    if (!thread.id) throw new Error("Missing Desktop thread")
    await turn(
      thread.id,
      "Think briefly, then say exactly desktop-proxy-ok.",
      "desktop-proxy-ok",
    )
    console.log("PASS: Desktop app-server turn and item lifecycle")
    await turn(
      thread.id,
      "Repeat the exact value you said in the previous turn, no other text.",
      "desktop-proxy-ok",
    )
    console.log("PASS: Desktop app-server multi-turn history")
  } finally {
    clearTimeout(deadline)
    await Promise.resolve()
      .then(() => child.stdin.end())
      .catch(() => undefined)
    child.kill()
    await Promise.allSettled([readerTask, stderrTask, child.exited])
  }

  if (stderr.includes("item completed without a recorded start timestamp")) {
    throw new Error("Desktop still reported mismatched item IDs")
  }
  await assertNoLifecycleWarningsInLogs(directory)
  console.log("PASS: Desktop logs contain no item identity mismatch warnings")
} finally {
  await local.stop(true)
  await rm(directory, { recursive: true, force: true })
}
