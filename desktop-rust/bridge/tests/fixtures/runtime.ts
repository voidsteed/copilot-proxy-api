import { expect } from "bun:test"
import { createServer } from "node:http"

import type { ProxyProcess } from "../../main/proxy-process"
import type { ActivityRecord } from "../../shared/contracts"
import type { FixtureUpstream } from "../../testing/upstream"

export async function eventually(
  predicate: () => boolean,
  timeout = 8000,
  diagnose?: () => Promise<unknown>,
): Promise<void> {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  try {
    expect(predicate()).toBe(true)
  } catch (error) {
    if (!diagnose) throw error
    throw new Error(JSON.stringify(await diagnose()), { cause: error })
  }
}

export async function expectRejection(task: Promise<unknown>): Promise<void> {
  let rejected = false
  try {
    await task
  } catch {
    rejected = true
  }
  expect(rejected).toBe(true)
}

export async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No test port")
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

export async function cancellationDiagnostics(runtime: {
  activity: ReadonlyArray<Pick<ActivityRecord, "outcome" | "status">>
  upstream: Pick<FixtureUpstream, "metrics">
  exits: ReadonlyArray<boolean>
  process: Pick<ProxyProcess, "drain">
}): Promise<unknown> {
  const drain = await runtime.process.drain(1).catch(() => "unavailable")
  return {
    cancellation: "client cancellation after first stream chunk",
    activity: runtime.activity.map(({ outcome, status }) => ({
      outcome,
      status,
    })),
    upstream: runtime.upstream.metrics,
    exits: runtime.exits,
    drain,
  }
}
