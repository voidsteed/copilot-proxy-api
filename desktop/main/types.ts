import type { DesktopSnapshot } from "../shared/contracts"

export interface StoredCredentials {
  githubToken: string
  gatewayKey: string
}

export interface CredentialVault {
  readonly mode: DesktopSnapshot["storageMode"]
  load(): Promise<StoredCredentials | null>
  save(credentials: StoredCredentials): Promise<void>
  clear(): Promise<void>
}

export interface ControllerOptions {
  dataDirectory: string
  runtimePath: string
  runtimeExecPath?: string
  fixtureOrigin?: string
  platform: DesktopSnapshot["platform"]
  version: string
  vault: CredentialVault
  writeClipboard(text: string): void | Promise<void>
  openExternal(url: string): Promise<void>
  applyLoginItem?(enabled: boolean): Promise<void>
}

export interface DesktopController {
  snapshot(): DesktopSnapshot
  invoke(input: unknown): Promise<DesktopSnapshot>
  subscribe(listener: (snapshot: DesktopSnapshot) => void): () => void
  dispose(): Promise<void>
}
