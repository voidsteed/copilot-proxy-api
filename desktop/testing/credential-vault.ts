import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

import type { CredentialVault, StoredCredentials } from "../main/types"

import { runtimeAuthenticationSchema } from "../../src/lib/proxy-contracts"
export function createMemoryCredentialVault(initial: StoredCredentials) {
  const encryptionKey = randomBytes(32)
  let credentials: StoredCredentials | null = structuredClone(initial)
  let fail = false
  const writes: Array<StoredCredentials> = []
  const vault: CredentialVault = {
    mode: "encrypted",
    load: () => Promise.resolve(credentials),
    save: (next) => {
      if (fail)
        return Promise.reject(new Error("Fixture encrypted save failed"))
      writes.push(structuredClone(next))
      credentials = structuredClone(next)
      return Promise.resolve()
    },
    clear: () => {
      credentials = null
      return Promise.resolve()
    },
    encodeRuntimeAuthentication(authentication) {
      const nonce = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce)
      const bytes = Buffer.concat([
        cipher.update(JSON.stringify(authentication), "utf8"),
        cipher.final(),
      ])
      return Promise.resolve(
        Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString("base64"),
      )
    },
    decodeRuntimeAuthentication(ciphertext) {
      const bytes = Buffer.from(ciphertext, "base64")
      const decipher = createDecipheriv(
        "aes-256-gcm",
        encryptionKey,
        bytes.subarray(0, 12),
      )
      decipher.setAuthTag(bytes.subarray(12, 28))
      const decoded = Buffer.concat([
        decipher.update(bytes.subarray(28)),
        decipher.final(),
      ])
      return Promise.resolve(
        runtimeAuthenticationSchema.parse(JSON.parse(decoded.toString("utf8"))),
      )
    },
  }
  return {
    vault,
    read: () => credentials,
    writes,
    fail: (value: boolean) => {
      fail = value
    },
  }
}
