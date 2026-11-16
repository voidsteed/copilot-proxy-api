import { expect, test } from "bun:test"

import type { CompletedRequestSummary } from "~/lib/request-log"

import { createDesktopProxy } from "~/desktop-proxy"

function gateway() {
  const completed: Array<CompletedRequestSummary> = []
  const app = createDesktopProxy({
    port: 34567,
    authentication: { kind: "keyed", keys: ["local-private"] },
    onComplete: (summary) => completed.push(summary),
  })
  return { app, completed }
}

const generationPath = "/v1beta/models/gemini-fixture:generateContent"

test("native Google header auth reaches the mounted Google validation boundary", async () => {
  const { app, completed } = gateway()
  const response = await app.request(
    `http://127.0.0.1:34567${generationPath}?key=query-private`,
    {
      method: "POST",
      headers: { host: "127.0.0.1:34567", "x-goog-api-key": "local-private" },
      body: "invalid JSON",
    },
  )
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    error: { code: 400, status: "INVALID_ARGUMENT" },
  })
  expect(completed).toHaveLength(1)
  expect(completed[0]?.outcome).toBe("failed")
  const retained = JSON.stringify(completed)
  for (const secret of ["local-private", "query-private", "x-goog-api-key"])
    expect(retained).not.toContain(secret)
})

test("native Google auth preserves all-present-valid policy and rejects query-only credentials", async () => {
  const { app } = gateway()
  const credentialSets: Array<Record<string, string>> = [
    {},
    { "x-goog-api-key": "wrong" },
    { "x-goog-api-key": "local-private", authorization: "Bearer wrong" },
    { "x-goog-api-key": "wrong", authorization: "Bearer local-private" },
    { "x-goog-api-key": "local-private", "x-api-key": "wrong" },
  ]
  for (const headers of credentialSets) {
    const response = await app.request(
      `http://127.0.0.1:34567${generationPath}?key=local-private`,
      {
        method: "POST",
        headers: { host: "127.0.0.1:34567", ...headers },
        body: "invalid JSON",
      },
    )
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: {
        code: 401,
        status: "UNAUTHENTICATED",
        message: "Missing or invalid gateway key",
      },
    })
  }
})
