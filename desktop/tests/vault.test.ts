import { afterEach, expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { StoredCredentials } from "../main/types"

import { createCredentialVault } from "../main/vault"

type VaultEncryption = NonNullable<
  Parameters<typeof createCredentialVault>[0]["encryption"]
>

const directories: Array<string> = []
const credentials = {
  githubToken: "fixture_github_token_for_vault_tests",
  gatewayKey: "fixture_gateway_key_for_vault_tests_0123456789",
} satisfies StoredCredentials

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "copilot-bridge-vault-"))
  directories.push(directory)
  return directory
}

function aesEncryption(): VaultEncryption {
  const key = randomBytes(32)
  return {
    encrypt(value) {
      const nonce = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", key, nonce)
      const ciphertext = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
      ])
      return Promise.resolve(
        Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]),
      )
    },
    decrypt(value) {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        value.subarray(0, 12),
      )
      decipher.setAuthTag(value.subarray(12, 28))
      const plaintext = Buffer.concat([
        decipher.update(value.subarray(28)),
        decipher.final(),
      ])
      return Promise.resolve({
        result: plaintext.toString("utf8"),
        shouldReEncrypt: false,
      })
    },
  }
}

async function savedFile(directory: string): Promise<string> {
  const files = await readdir(directory)
  expect(files).toHaveLength(1)
  const [filename] = files
  if (!filename) throw new Error("The vault did not save its encrypted file")
  return join(directory, filename)
}

test("encrypted credentials survive a vault restart without plaintext or read-time rewriting", async () => {
  const directory = await temporaryDirectory()
  const encryption = aesEncryption()
  const vault = createCredentialVault({ directory, encryption })
  expect(vault.mode).toBe("encrypted")
  expect(await vault.load()).toBeNull()
  await vault.save(credentials)
  const filename = await savedFile(directory)
  const ciphertext = await readFile(filename)
  expect(ciphertext.includes(Buffer.from(credentials.githubToken))).toBe(false)
  expect(ciphertext.includes(Buffer.from(credentials.gatewayKey))).toBe(false)
  const restarted = createCredentialVault({ directory, encryption })
  expect(await restarted.load()).toEqual(credentials)
  expect(await readFile(filename)).toEqual(ciphertext)
  if (process.platform !== "win32") {
    expect((await stat(filename)).mode & 0o777).toBe(0o600)
  }
})

test("session-only storage writes no files and gives each vault an isolated, copied session", async () => {
  const parent = await temporaryDirectory()
  const directory = join(parent, "session")
  const vault = createCredentialVault({ directory, encryption: null })
  expect(vault.mode).toBe("session-only")
  await vault.save(credentials)
  const loaded = await vault.load()
  expect(loaded).toEqual(credentials)
  if (!loaded) throw new Error("Session credentials were not returned")
  loaded.githubToken = "changed_by_a_caller"
  expect(await vault.load()).toEqual(credentials)
  expect(
    await createCredentialVault({ directory, encryption: null }).load(),
  ).toBeNull()
  await vault.clear()
  await vault.clear()
  expect(await vault.load()).toBeNull()
  expect(await readdir(parent)).toEqual([])
})

test("sign-out without encryption removes credentials saved by an earlier encrypted session", async () => {
  const directory = await temporaryDirectory()
  const encryption = aesEncryption()
  await createCredentialVault({ directory, encryption }).save(credentials)
  const session = createCredentialVault({ directory, encryption: null })
  await session.save({
    ...credentials,
    githubToken: "fixture_temporary_account",
  })
  await session.clear()
  await session.clear()
  expect(await session.load()).toBeNull()
  expect(
    await createCredentialVault({ directory, encryption }).load(),
  ).toBeNull()
  expect(await readdir(directory)).toEqual([])
})

test("tampered ciphertext reports a safe sign-in error and leaves the saved file intact", async () => {
  const directory = await temporaryDirectory()
  const encryption = aesEncryption()
  const vault = createCredentialVault({ directory, encryption })
  await vault.save(credentials)
  const filename = await savedFile(directory)
  const tampered = await readFile(filename)
  tampered[tampered.length - 1] ^= 1
  await writeFile(filename, tampered)
  await rejects(vault.load(), {
    name: "Error",
    message: "Saved sign-in could not be unlocked. Sign in again.",
  })
  expect(await readFile(filename)).toEqual(tampered)
})

test.each([
  "not JSON fixture_github_token_for_vault_tests",
  JSON.stringify({ githubToken: credentials.githubToken, gatewayKey: "short" }),
])("malformed decrypted credentials fail safely for %s", async (plaintext) => {
  const directory = await temporaryDirectory()
  const encryption = aesEncryption()
  const vault = createCredentialVault({ directory, encryption })
  await vault.save(credentials)
  const filename = await savedFile(directory)
  await writeFile(filename, await encryption.encrypt(plaintext))
  await rejects(vault.load(), {
    name: "Error",
    message: "Saved sign-in could not be unlocked. Sign in again.",
  })
})

test("a failed encrypted replacement preserves the previous recoverable credentials", async () => {
  const directory = await temporaryDirectory()
  const encryption = aesEncryption()
  const vault = createCredentialVault({ directory, encryption })
  await vault.save(credentials)
  const filename = await savedFile(directory)
  const before = await readFile(filename)
  const replacement = createCredentialVault({
    directory,
    encryption: {
      ...encryption,
      encrypt: () => Promise.reject(new Error("Synthetic encryption failure")),
    },
  })
  await rejects(
    replacement.save({ ...credentials, githubToken: "fixture_replacement" }),
    /Synthetic encryption failure/,
  )
  expect(await readFile(filename)).toEqual(before)
  expect(await vault.load()).toEqual(credentials)
  expect(await readdir(directory)).toHaveLength(1)
})

test("invalid replacement credentials preserve the previous sign-in", async () => {
  const directory = await temporaryDirectory()
  const vault = createCredentialVault({
    directory,
    encryption: aesEncryption(),
  })
  await vault.save(credentials)
  await rejects(
    vault.save({ githubToken: "fixture_replacement", gatewayKey: "short" }),
  )
  expect(await vault.load()).toEqual(credentials)
})

test("encrypted clear is idempotent before and after a saved sign-in", async () => {
  const parent = await temporaryDirectory()
  const directory = join(parent, "encrypted")
  const encryption = aesEncryption()
  const vault = createCredentialVault({ directory, encryption })
  await vault.clear()
  await vault.save(credentials)
  await vault.clear()
  await vault.clear()
  expect(await vault.load()).toBeNull()
  expect(
    await createCredentialVault({ directory, encryption }).load(),
  ).toBeNull()
  expect(await readdir(directory)).toEqual([])
})

test("load awaits asynchronous re-encryption and persists credentials under the replacement key", async () => {
  const directory = await temporaryDirectory()
  const legacy = aesEncryption()
  const current = aesEncryption()
  const previous = createCredentialVault({ directory, encryption: legacy })
  await previous.save(credentials)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const rotating = createCredentialVault({
    directory,
    encryption: {
      async encrypt(value) {
        entered.resolve(undefined)
        await release.promise
        return current.encrypt(value)
      },
      async decrypt(value) {
        return { ...(await legacy.decrypt(value)), shouldReEncrypt: true }
      },
    },
  })
  let settled = false
  const loading = rotating.load().then((value) => {
    settled = true
    return value
  })
  await entered.promise
  expect(settled).toBe(false)
  expect(await previous.load()).toEqual(credentials)
  release.resolve(undefined)
  expect(await loading).toEqual(credentials)
  expect(
    await createCredentialVault({ directory, encryption: current }).load(),
  ).toEqual(credentials)
  await rejects(previous.load(), /could not be unlocked/)
})
