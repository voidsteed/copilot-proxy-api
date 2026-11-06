import assert from "node:assert/strict"

import type { OpenProxySessionOptions } from "../../src/lib/proxy-contracts"
import type { DesktopController } from "./types"

import { cliProxyOptions, openProxySession } from "../../src/lib/proxy-session"

const sharingChecks = [
  "CLI and native window attach to one gateway with the same private connection and catalog",
  "CLI refresh and subscriptions observe native state without exposing credentials",
  "CLI Stop and Start update the native window and invalidate stale creator leases",
  "CLI account replacement appears in the signed-in window and UI cancellation preserves the account and gateway",
  "Disconnecting CLI observers preserves the native-owned gateway",
]

export async function verifyNativeSharing(options: {
  controller: DesktopController
  homeDirectory: string
  stateDirectory: string
  verifyReplacement(): Promise<void>
}): Promise<Array<string>> {
  const { controller } = options
  const connection = controller.activeConnection()
  assert(connection, "The native gateway has a real active connection")
  const request = {
    ...(await cliProxyOptions(options)),
    intent: {
      kind: "ensure-running",
      explicit: {},
      credential: { kind: "native-saved-account" },
    },
  } satisfies OpenProxySessionOptions
  const observer = await openProxySession(request)
  assert(observer.kind === "managed")
  const releases: Array<() => Promise<void>> = [() => observer.release()]
  let unsubscribe: (() => void) | undefined
  try {
    const initial = await observer.read()
    assert(initial.kind === "managed")
    assert.equal(initial.gateway.kind, "running")
    assert.equal(observer.lifecycle.kind, "observer")
    assert.deepEqual(await observer.connection(), connection)
    assert.equal(initial.catalog.length, controller.snapshot().models.length)
    assert(!JSON.stringify(initial).includes("fixture_github_token"))
    assert(
      !JSON.stringify(initial).includes(
        connection.authentication.kind === "keyed" ?
          connection.authentication.key
        : "credential-sentinel",
      ),
    )

    let subscribedRevision = -1
    unsubscribe = observer.subscribe((snapshot) => {
      if (snapshot.kind === "managed") subscribedRevision = snapshot.revision
    })
    const refresh = await observer.invoke({ kind: "refresh" })
    assert.equal(refresh.kind, "applied")
    const refreshed = await observer.read()
    assert.equal(refreshed.kind, "managed")
    const deadline = Date.now() + 5000
    while (
      (subscribedRevision < refreshed.revision
        || subscribedRevision <= initial.revision)
      && Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 20))
    assert(
      subscribedRevision >= refreshed.revision
        && subscribedRevision > initial.revision,
      "The CLI subscription receives the refreshed native state",
    )
    unsubscribe()

    const lease = {
      sessionId: initial.sessionId,
      gatewayGeneration: initial.gatewayGeneration,
    }
    const stopped = await observer.invoke({
      kind: "stop-gateway",
      expected: lease,
      timeoutMs: 5000,
    })
    assert.equal(stopped.kind, "applied")
    assert.equal(controller.snapshot().gateway.kind, "stopped")
    const creator = await openProxySession(request)
    assert(creator.kind === "managed")
    releases.push(() => creator.release())
    assert.equal(creator.lifecycle.kind, "creator")
    assert.equal(controller.snapshot().gateway.kind, "running")
    const restarted = await creator.read()
    assert.equal(restarted.kind, "managed")
    assert(restarted.gatewayGeneration > initial.gatewayGeneration)
    const stale = await observer.invoke({
      kind: "stop-gateway",
      expected: lease,
      timeoutMs: 5000,
    })
    assert.equal(stale.kind, "session-changed")
    const account = controller.snapshot().account
    assert.equal(account.kind, "signed-in")
    const authorization = await observer.invoke({ kind: "authorize" })
    assert.equal(authorization.kind, "applied")
    await options.verifyReplacement()
    assert.deepEqual(controller.snapshot().account, account)
    assert.equal(controller.snapshot().authorization.kind, "idle")
    assert.equal(controller.snapshot().gateway.kind, "running")
    await observer.release()
    await creator.release()
    assert.equal(controller.snapshot().gateway.kind, "running")
    assert.deepEqual(controller.activeConnection(), connection)
    return [...sharingChecks]
  } finally {
    unsubscribe?.()
    for (const release of releases.reverse()) await release()
  }
}
