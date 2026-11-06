import { expect, test } from "bun:test"
import { build } from "esbuild"
import { fork } from "node:child_process"
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

const root = fileURLToPath(new URL("../../", import.meta.url))
const eventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready") }),
  z.object({
    kind: z.literal("drain-result"),
    result: z.object({ kind: z.literal("drained") }),
  }),
  z.object({ kind: z.literal("stopped") }),
])

async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No test port")
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

test("the shipped Node listener drains the complete outgoing response before closing keepalive sockets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "copilot-proxy-node-drain-"))
  const libraryPath = join(directory, "listener.cjs")
  const runnerPath = join(directory, "node-listener.cjs")
  const port = await availablePort()
  let child: ReturnType<typeof fork> | undefined
  try {
    await symlink(
      await realpath(join(root, "desktop/node_modules")),
      join(directory, "node_modules"),
    )
    await build({
      entryPoints: [join(root, "desktop/engine/runtime.ts")],
      outfile: libraryPath,
      absWorkingDir: root,
      tsconfig: join(root, "tsconfig.json"),
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      external: ["pdf-parse"],
      logLevel: "silent",
    })
    await writeFile(
      runnerPath,
      [
        "const { createNodeListener } = require(process.argv[2])",
        "let stream",
        "const started = createNodeListener({port: Number(process.argv[3]), fetch: async (request) => {",
        "  await request.text()",
        String.raw`  return new Response(new ReadableStream({start(controller) { stream = controller; controller.enqueue(new TextEncoder().encode("data: first\n\n")) }}), {headers: {"content-type":"text/event-stream"}})`,
        "}})",
        'started.then(() => process.send({kind:"ready"}))',
        'process.on("message", async (message) => {',
        "  const listener = await started",
        '  if (message.kind === "drain") process.send({kind:"drain-result", result: await listener.drain(2000)})',
        String.raw`  if (message.kind === "finish") { stream.enqueue(new TextEncoder().encode("data: last\n\n")); stream.close() }`,
        '  if (message.kind === "stop") { await listener.stop(); process.send({kind:"stopped"}); process.exit(0) }',
        "})",
        'process.on("disconnect", () => { started.then((listener) => listener.forceStop()).then(() => process.exit(0)) })',
      ].join("\n"),
    )
    child = fork(runnerPath, [libraryPath, String(port)], {
      execPath: "node",
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    })
    const ready = Promise.withResolvers<undefined>()
    const drained = Promise.withResolvers<{ kind: "drained" }>()
    const exited = Promise.withResolvers<undefined>()
    let drainFinished = false
    child.on("message", (input: unknown) => {
      const event = eventSchema.parse(input)
      if (event.kind === "ready") ready.resolve(undefined)
      if (event.kind === "drain-result") {
        drainFinished = true
        drained.resolve(event.result)
      }
    })
    child.once("exit", () => exited.resolve(undefined))
    child.once("error", ready.reject)
    await ready.promise
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      body: "{}",
    })
    const reader = response.body?.getReader()
    expect((await reader?.read())?.done).toBe(false)
    child.send({ kind: "drain" })
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(drainFinished).toBe(false)
    child.send({ kind: "finish" })
    let text = ""
    if (reader)
      while (true) {
        const item = await reader.read()
        if (item.done) break
        text += new TextDecoder().decode(item.value)
      }
    expect(text).toContain("data: last")
    expect(await drained.promise).toEqual({ kind: "drained" })
    child.send({ kind: "stop" })
    await exited.promise
    expect(child.exitCode).toBe(0)
  } finally {
    child?.kill("SIGTERM")
    await rm(directory, { recursive: true, force: true })
  }
}, 10_000)
