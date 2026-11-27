import { app, safeStorage } from "electron"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import { createCredentialVault } from "./vault"

export async function runNativeVaultSmoke(options: {
  dataDirectory: string
  outputDirectory: string
}): Promise<void> {
  if (!(await safeStorage.isAsyncEncryptionAvailable()))
    throw new Error("Native credential encryption is unavailable.")
  const filename = path.join(options.dataDirectory, "credentials.enc")
  const ciphertext = await fs.readFile(filename)
  const vault = createCredentialVault({
    directory: options.dataDirectory,
    encryption: {
      encrypt: (value) => safeStorage.encryptStringAsync(value),
      decrypt: (value) => safeStorage.decryptStringAsync(value),
    },
  })
  if (!(await vault.load()))
    throw new Error("The isolated encrypted credential copy is empty.")
  if (!(await fs.readFile(filename)).equals(ciphertext))
    throw new Error("The isolated encrypted credential copy was migrated.")
  await fs.mkdir(options.outputDirectory, { recursive: true, mode: 0o700 })
  await fs.writeFile(
    path.join(options.outputDirectory, "native-vault.json"),
    JSON.stringify(
      {
        passed: true,
        version: app.getVersion(),
        credentialStorage: vault.mode,
        credentialsRecovered: true,
        ciphertextUnchanged: true,
        ciphertextSha256: createHash("sha256").update(ciphertext).digest("hex"),
        scope: "Native decryption of an isolated encrypted credential copy",
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  )
}
