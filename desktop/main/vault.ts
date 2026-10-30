import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"

import type { CredentialVault, StoredCredentials } from "./types"

const credentialsSchema = z
  .object({
    githubToken: z.string().min(1),
    gatewayKey: z.string().min(32),
  })
  .strict()

interface Encryption {
  encrypt(value: string): Promise<Buffer>
  decrypt(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
}

async function clearSavedCredentials(filename: string): Promise<void> {
  await fs.unlink(filename).catch((error: unknown) => {
    if (
      !(error instanceof Error)
      || !("code" in error)
      || error.code !== "ENOENT"
    ) {
      throw new Error("Saved sign-in could not be removed.")
    }
  })
}

export function createCredentialVault(options: {
  directory: string
  encryption: Encryption | null
}): CredentialVault {
  const filename = path.join(options.directory, "credentials.enc")
  const encryption = options.encryption
  if (!encryption) {
    let credentials: StoredCredentials | null = null
    return {
      mode: "session-only",
      load: () => Promise.resolve(credentials && { ...credentials }),
      save(value) {
        credentials = credentialsSchema.parse(value)
        return Promise.resolve()
      },
      async clear() {
        credentials = null
        await clearSavedCredentials(filename)
      },
    }
  }

  const save = async (credentials: StoredCredentials): Promise<void> => {
    const value = credentialsSchema.parse(credentials)
    const ciphertext = await encryption.encrypt(JSON.stringify(value))
    const temporary = `${filename}.${randomUUID()}.tmp`
    await fs.mkdir(options.directory, { recursive: true, mode: 0o700 })
    try {
      await fs.writeFile(temporary, ciphertext, { mode: 0o600, flag: "wx" })
      await fs.rename(temporary, filename)
    } finally {
      await fs.unlink(temporary).catch((error: unknown) => {
        if (
          !(error instanceof Error)
          || !("code" in error)
          || error.code !== "ENOENT"
        )
          throw error
      })
    }
  }

  return {
    mode: "encrypted",
    async load() {
      let bytes: Buffer
      try {
        bytes = await fs.readFile(filename)
      } catch (error) {
        if (
          error instanceof Error
          && "code" in error
          && error.code === "ENOENT"
        )
          return null
        throw new Error("Saved sign-in could not be read. Sign in again.")
      }
      try {
        const decrypted = await encryption.decrypt(bytes)
        const value: unknown = JSON.parse(decrypted.result)
        if (decrypted.shouldReEncrypt)
          await save(credentialsSchema.parse(value))
        return credentialsSchema.parse(value)
      } catch {
        throw new Error("Saved sign-in could not be unlocked. Sign in again.")
      }
    },
    save,
    clear: () => clearSavedCredentials(filename),
  }
}
