import { defineCommand } from "citty"
import consola from "consola"
import { z } from "zod"

import { cliProxyOptions, observeProxySession } from "./lib/proxy-session"

export async function runStop(
  options: {
    homeDirectory?: string
    stateDirectory?: string
    timeoutMs?: number
  } = {},
): Promise<void> {
  const timeoutMs = z
    .number()
    .int()
    .min(1)
    .max(60_000)
    .parse(options.timeoutMs ?? 15_000)
  const session = await observeProxySession(await cliProxyOptions(options))
  if (session.kind === "unavailable") throw new Error(session.message)
  if (session.kind === "standalone")
    throw new Error("No managed Copilot Proxy is running.")
  try {
    const snapshot = await session.read()
    if (session.kind !== "managed" || snapshot.kind !== "managed")
      throw new Error(
        "The existing CLI is read-only. Stop it normally in its Terminal.",
      )
    if (snapshot.gateway.kind === "stopped") {
      consola.info("Copilot Proxy is already stopped.")
      return
    }
    const result = await session.invoke({
      kind: "stop-gateway",
      expected: {
        sessionId: snapshot.sessionId,
        gatewayGeneration: snapshot.gatewayGeneration,
      },
      timeoutMs,
    })
    if (result.kind === "unavailable") throw new Error(result.message)
    if (result.kind !== "applied")
      throw new Error("The proxy changed before Stop. Run the command again.")
    consola.success("Copilot Proxy stopped.")
  } finally {
    await session.release()
  }
}

export const stop = defineCommand({
  meta: {
    name: "stop",
    description: "Stop the shared native Copilot Proxy gateway",
  },
  args: {
    "timeout-ms": {
      type: "string",
      default: "15000",
      description: "Stop acknowledgment timeout in milliseconds",
    },
  },
  run({ args }) {
    return runStop({ timeoutMs: Number(args["timeout-ms"]) })
  },
})
