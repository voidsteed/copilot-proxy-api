import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { selectDataDirectory } from "../main/profile"
import { createCredentialVault } from "../main/vault"

test("production uses the platform profile unless a directory is explicit", () => {
  expect(selectDataDirectory({ fixture: false })).toBeUndefined()
})

test.each([false, true])(
  "an explicit data directory wins with fixture=%s",
  (fixture) => {
    expect(
      selectDataDirectory({ fixture, explicit: "profile with spaces" }),
    ).toBe(path.resolve("profile with spaces"))
  },
)

test("default fixture sign-out preserves a previous production profile and each launch is isolated", async () => {
  const production = await fs.mkdtemp(
    path.join(os.tmpdir(), "copilot-bridge-profile-test-"),
  )
  const saved = path.join(production, "credentials.enc")
  const original = Buffer.from("opaque_saved_profile_bytes_for_isolation")
  await fs.writeFile(saved, original)
  const first = selectDataDirectory({ fixture: true })
  const second = selectDataDirectory({ fixture: true })
  try {
    const vault = createCredentialVault({
      directory: first ?? production,
      encryption: null,
    })
    await vault.save({
      githubToken: "fixture_account",
      gatewayKey: "fixture_gateway_key_01234567890123456789",
    })
    await vault.clear()
    expect(await fs.readFile(saved)).toEqual(original)
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(first).not.toBe(second)
    if (!first || !second)
      throw new Error("Fixture launch did not create an isolated profile")
    expect((await fs.stat(first)).isDirectory()).toBe(true)
    expect((await fs.stat(second)).isDirectory()).toBe(true)
  } finally {
    for (const directory of new Set([production, first, second])) {
      if (directory) await fs.rm(directory, { recursive: true, force: true })
    }
  }
})
