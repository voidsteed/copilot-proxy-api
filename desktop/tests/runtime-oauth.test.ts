import { afterEach, describe, expect, test } from "bun:test"
import { createServer } from "node:http"

import { authorizeDevice, DeviceFlowError } from "../main/oauth"
import { startFixtureUpstream } from "../testing/upstream"
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function fixture() {
  const upstream = await startFixtureUpstream()
  cleanups.push(() => upstream.close())
  return upstream
}
async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20))
  expect(predicate()).toBe(true)
}
async function expectRejection(task: Promise<unknown>): Promise<void> {
  let rejected = false
  try {
    await task
  } catch {
    rejected = true
  }
  expect(rejected).toBe(true)
}
describe("bounded device authorization", () => {
  test("denied and expired grants terminate with explicit safe outcomes", async () => {
    for (const mode of ["denied", "expired"] as const) {
      const upstream = await fixture()
      upstream.setOAuthMode(mode)
      const task = authorizeDevice({
        fixtureOrigin: upstream.origin,
        signal: new AbortController().signal,
        onCode: () => undefined,
      })
      try {
        await task
        throw new Error("Expected device authorization failure")
      } catch (error) {
        expect(error).toBeInstanceOf(DeviceFlowError)
        expect(error instanceof DeviceFlowError ? error.kind : "unknown").toBe(
          mode,
        )
      }
    }
  }, 10000)
  test("slow_down postpones further polling and cancellation ends the wait", async () => {
    const upstream = await fixture()
    upstream.setOAuthMode("slow")
    const abort = new AbortController()
    const task = authorizeDevice({
      fixtureOrigin: upstream.origin,
      signal: abort.signal,
      onCode: () => undefined,
    })
    await eventually(() => upstream.metrics.requests === 2)
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(upstream.metrics.requests).toBe(2)
    abort.abort()
    await expectRejection(task)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(upstream.metrics.requests).toBe(2)
  }, 8000)
  test("device expiry stops a pending poll even when the network does not respond", async () => {
    let polls = 0
    const server = createServer((request, response) => {
      request.resume()
      if (request.url === "/login/device/code") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            device_code: "fixture-expiring",
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            expires_in: 0.15,
            interval: 0.02,
          }),
        )
      } else polls++
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    cleanups.push(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    const address = server.address()
    if (!address || typeof address === "string")
      throw new Error("No expiry fixture port")
    const task = authorizeDevice({
      fixtureOrigin: `http://127.0.0.1:${address.port}`,
      signal: new AbortController().signal,
      onCode: () => undefined,
    })
    try {
      await task
      throw new Error("Expected device expiry")
    } catch (error) {
      expect(error).toBeInstanceOf(DeviceFlowError)
      expect(error instanceof DeviceFlowError ? error.kind : "unknown").toBe(
        "expired",
      )
    }
    expect(polls).toBe(1)
  }, 5000)
  test("an untrusted device URL never becomes an authorization page", async () => {
    const server = createServer((request, response) => {
      request.resume()
      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          device_code: "fixture-untrusted",
          user_code: "ABCD-EFGH",
          verification_uri: "https://github.com.evil.test/login/device",
          expires_in: 10,
          interval: 1,
        }),
      )
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    )
    const address = server.address()
    if (!address || typeof address === "string")
      throw new Error("No device URL fixture port")
    let showedCode = false
    await expectRejection(
      authorizeDevice({
        fixtureOrigin: `http://127.0.0.1:${address.port}`,
        signal: new AbortController().signal,
        onCode: () => {
          showedCode = true
        },
      }),
    )
    expect(showedCode).toBe(false)
  })
})
