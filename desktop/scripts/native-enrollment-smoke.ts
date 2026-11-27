import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs/promises"
import { createServer } from "node:net"
import path from "node:path"
import { z } from "zod"

import { nativePackageFingerprint } from "../../src/lib/proxy-session"
import {
  connectProxyClient,
  PROTOCOL_VERSION,
  publisherAddressSchema,
} from "../../src/lib/proxy-session-wire"

const recordSchema = z.object({
  kind: z.literal("copilot-proxy-native-session"),
  protocol: z.literal(PROTOCOL_VERSION),
  pid: z.number().int().positive(),
  ...publisherAddressSchema.shape,
})
const installationSchema = z.object({
  kind: z.literal("copilot-proxy-native-installation"),
  protocol: z.literal(PROTOCOL_VERSION),
  executablePath: z.string(),
  packageFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
})

type ProcessStatus = { code: number | null; signal: string | null }

async function finishNative(options: {
  child: ChildProcess
  exited: Promise<ProcessStatus>
  output: string
  stateDirectory: string
  timedOut: boolean
  startedAt: number
}): Promise<void> {
  if (options.child.exitCode === null && options.child.signalCode === null)
    options.child.kill("SIGTERM")
  const forceQuit = setTimeout(() => options.child.kill("SIGKILL"), 5000)
  const status = await options.exited
  clearTimeout(forceQuit)
  await fs.writeFile(
    path.join(options.output, "process-status.json"),
    JSON.stringify(
      {
        ...status,
        timedOut: options.timedOut,
        elapsedMs: Date.now() - options.startedAt,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  )
  await fs
    .unlink(path.join(options.stateDirectory, "installation.json"))
    .catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return
      throw error
    })
}

async function availableInspectorPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address === "object")
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  return address.port
}

async function waitForEnrollment(options: {
  directory: string
  pid: number
  executable: string
}) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const installation = await fs
      .readFile(path.join(options.directory, "installation.json"), "utf8")
      .catch(() => null)
    const sessions = await fs
      .readdir(path.join(options.directory, "sessions"))
      .catch(() => [])
    if (installation) {
      const installed = installationSchema.parse(JSON.parse(installation))
      assert.equal(installed.executablePath, options.executable)
      for (const session of sessions) {
        const raw = await fs
          .readFile(
            path.join(options.directory, "sessions", session, "control.json"),
            "utf8",
          )
          .catch(() => null)
        if (!raw) continue
        const record = recordSchema.parse(JSON.parse(raw))
        if (record.pid === options.pid) return { installed, record }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("The isolated non-fixture native app did not enroll.")
}

async function quitOwnApp(port: number): Promise<void> {
  const targets: unknown = await (
    await fetch(`http://127.0.0.1:${port}/json/list`)
  ).json()
  const target = z
    .array(z.object({ webSocketDebuggerUrl: z.string() }))
    .min(1)
    .parse(targets)[0]
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve())
    socket.addEventListener("error", () =>
      reject(new Error("The native inspector failed.")),
    )
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("The native app did not accept quit.")),
        5000,
      )
      socket.addEventListener("message", (event) => {
        assert(typeof event.data === "string")
        const response = z
          .object({
            id: z.number().optional(),
            result: z
              .object({ exceptionDetails: z.unknown().optional() })
              .optional(),
            error: z.unknown().optional(),
          })
          .parse(JSON.parse(event.data))
        if (response.id !== 1) return
        clearTimeout(timer)
        if (response.error || response.result?.exceptionDetails) {
          reject(new Error("The native inspector rejected app.quit."))
          return
        }
        resolve()
      })
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: {
            expression:
              "(() => { const app = process.getBuiltinModule('module').createRequire(process.execPath)('electron').app; setTimeout(() => app.quit(), 100); return true; })()",
          },
        }),
      )
    })
  } finally {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5000)
      socket.addEventListener("close", () => {
        clearTimeout(timer)
        resolve()
      })
      socket.close()
    })
  }
}

async function run(): Promise<void> {
  const executable = process.env.COPILOT_PROXY_EXECUTABLE
  const output = process.env.COPILOT_PROXY_SMOKE_OUTPUT
  assert(executable && path.isAbsolute(executable))
  assert(output && output.startsWith("/Volumes/mac-ssd/AI/projects/"))
  assert.equal(process.platform, "darwin")
  await fs.mkdir(output, { recursive: true, mode: 0o700 })
  const dataDirectory = path.join(output, "user-data")
  const stateDirectory = path.join(output, "state")
  await fs.mkdir(dataDirectory, { mode: 0o700 })
  const port = await availableInspectorPort()
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const startedAt = Date.now()
  const log = await fs.open(path.join(output, "electron.log"), "w", 0o600)
  const child = spawn(
    executable,
    [
      "--data-dir",
      dataDirectory,
      "--state-dir",
      stateDirectory,
      `--inspect=127.0.0.1:${port}`,
    ],
    { env: environment, stdio: ["ignore", log.fd, log.fd] },
  )
  assert(child.pid)
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) => resolve({ code, signal }))
    },
  )
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, 125_000)
  try {
    const enrollment = await waitForEnrollment({
      directory: stateDirectory,
      pid: child.pid,
      executable,
    })
    const cliFingerprint = await nativePackageFingerprint(executable)
    assert.equal(enrollment.installed.packageFingerprint, cliFingerprint)
    const client = connectProxyClient(
      publisherAddressSchema.parse({
        publisherId: enrollment.record.publisherId,
        nonce: enrollment.record.nonce,
        socketPath: enrollment.record.socketPath,
      }),
    )
    const snapshot = await client.read()
    await client.release()
    await quitOwnApp(port)
    const status = await exited
    assert(!timedOut)
    assert.equal(status.code, 0)
    assert.equal(status.signal, null)
    await fs.writeFile(
      path.join(output, "enrollment.json"),
      JSON.stringify(
        {
          passed: true,
          fixture: false,
          temporaryDataDirectory: true,
          temporaryStateDirectory: true,
          nativeOwnerPid: child.pid,
          nativeFingerprintMatchesCli: true,
          packageFingerprint: cliFingerprint,
          snapshotKind: snapshot.kind,
          status: { ...status, timedOut, elapsedMs: Date.now() - startedAt },
          checks: [
            "Real packaged main enrolls without fixture mode",
            "Both native fingerprint and fresh host validation use physical files",
            "Native and CLI fingerprints agree for the same packaged bytes",
            "Only the exact temporary native owner's private channel is read",
            "The temporary native app exits gracefully without a wake operation",
          ],
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    )
  } finally {
    clearTimeout(timer)
    await finishNative({
      child,
      exited,
      output,
      stateDirectory,
      timedOut,
      startedAt,
    })
    await log.close()
  }
}

void run().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Native enrollment failed.",
  )
  process.exitCode = 1
})
