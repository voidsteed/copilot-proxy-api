import type {
  AgentModel,
  ConfigurableAgent,
  NativeConnection,
  NativeSessionAuthority,
  RuntimeOverrides,
} from "../../src/lib/proxy-contracts"
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
  encodeRuntimeAuthentication?(
    authentication: NonNullable<RuntimeOverrides["authentication"]>,
  ): Promise<string | null>
  decodeRuntimeAuthentication?(
    ciphertext: string,
  ): Promise<NonNullable<RuntimeOverrides["authentication"]>>
}

export interface ControllerOptions {
  dataDirectory: string
  homeDirectory?: string
  stateDirectory?: string
  runtimePath: string
  runtimeExecPath?: string
  fixtureOrigin?: string
  platform: DesktopSnapshot["platform"]
  version: string
  vault: CredentialVault
  writeClipboard(text: string): void | Promise<void>
  openExternal(url: string): Promise<void>
  openFolder?(path: string): Promise<void>
  showUi?(): void | Promise<void>
  applyLoginItem?(enabled: boolean): Promise<void>
}

export interface DesktopController {
  snapshot(): DesktopSnapshot
  invoke(input: unknown): Promise<DesktopSnapshot>
  sessionApi(): NativeSessionAuthority
  activeConnection(): NativeConnection | null
  agentProposal(
    target: ConfigurableAgent,
  ): Extract<AgentModel, { kind: "proposed" }> | null
  subscribe(listener: (snapshot: DesktopSnapshot) => void): () => void
  dispose(): Promise<void>
}
