import { fork } from "node:child_process"
import { fileURLToPath } from "node:url"
import { z } from "zod"

const observationSchema = z.object({
  bytes: z.number().int().positive(),
  destroyed: z.boolean(),
})

export async function closeStreamingClient(options: {
  origin: string
  headers: Record<string, string>
  registerCleanup(cleanup: () => Promise<void>): void
}): Promise<z.infer<typeof observationSchema>> {
  const client = fork(
    fileURLToPath(new URL("./cancellation-client.mjs", import.meta.url)),
    [],
    {
      execPath: "node",
      execArgv: [],
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json",
    },
  )
  options.registerCleanup(() => {
    if (client.exitCode === null) client.kill()
    return Promise.resolve()
  })
  const closed = await new Promise<unknown>((resolve, reject) => {
    let observation: unknown
    client.once("message", (value: unknown) => {
      observation = value
    })
    client.once("error", reject)
    client.once("exit", (code) => {
      if (code === 0) resolve(observation)
      else reject(new Error(`Cancellation client exited with code ${code}`))
    })
    client.once("spawn", () => {
      client.send({ origin: options.origin, headers: options.headers })
    })
  })
  return observationSchema.parse(closed)
}
