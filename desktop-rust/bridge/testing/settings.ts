import { createServer } from "node:net"

import type { DesktopController } from "../main/types"

export async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("Could not allocate a test port.")
  const port = address.port
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  return port
}

export async function isolateFixturePort(
  controller: DesktopController,
): Promise<void> {
  if (controller.snapshot().settings.port !== 4141) return
  await controller.invoke({
    kind: "save-settings",
    settings: {
      ...controller.snapshot().settings,
      port: await availablePort(),
      launchAtLogin: false,
    },
  })
}
