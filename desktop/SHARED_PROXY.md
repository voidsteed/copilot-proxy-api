# Shared proxy contracts

The installed native controller owns encrypted account storage and the managed gateway. The CLI discovers that controller through `proxy-session.ts`. An already running older CLI remains a legacy attachment with observation and release only. A native broker attached to a legacy gateway exposes the same legacy capabilities.

`src/lib/proxy-contracts.ts` owns the shared Zod schemas and their inferred domain types. Source modules do not import desktop types. `desktop/shared/contracts.ts` re-exports the public model, usage, activity, connection, and agent types and adds renderer snapshots and commands.

## Module interfaces

The implementation modules export these functions.

```ts
// src/lib/proxy-session.ts
openProxySession(options: OpenProxySessionOptions): Promise<ProxySession>
hostProxySession(options: HostProxySessionOptions): Promise<() => Promise<void>>

// src/lib/legacy-proxy.ts
probeLegacyProxy(options: LegacyProbeOptions): Promise<LegacySession | null>

// src/lib/agent-config.ts
inspectAgentConfigs(options: InspectAgentConfigsOptions): Promise<AgentConfigView[]>
configureMissingAgent(options: ConfigureMissingAgentOptions): Promise<ConfigureResult>
getAgentConfigFolder(target: ConfigurableAgent, homeDirectory: string): string
configuredProxyRoots(homeDirectory: string): Promise<LoopbackRootUrl[]>
configuredProxyConnections(homeDirectory: string): Promise<NativeConnection[]>
```

`proxy-session.ts` owns private transport, discovery, registration checks, and the fixed native executable launch. On macOS, it accepts bounded, schema-validated requests on a user-only Unix socket and verifies the process nonce before accepting commands. Other platforms report native control as unsupported. Account and runtime controls stay off public inference HTTP.

`NativePackageFileSystem` contains the five Node filesystem methods used to validate package identity and hash package bytes. Desktop passes `original-fs.promises` to both `nativePackageFingerprint()` and `hostProxySession()` because Electron's patched filesystem presents an ASAR archive as a directory. Node and Bun use their normal physical filesystem. The host recomputes the fingerprint before enrollment, and state and socket reads use their existing filesystem.

`legacy-proxy.ts` identifies the inference server from its local greeting, authenticated catalog, and request-log schema. Local health polling requires the greeting and catalog. GitHub quota refresh runs independently and at most once per minute. Failed quota and later request-log reads preserve the last validated data. A quota failure does not change local reachability. A returned `LegacySession` has no account, runtime mutation, drain, or PID-signaling operation. `ObservedActivity` uses `outcome: "observed"` and null model and token fields. Its duration measures the legacy handler. Its cumulative totals stay null where the older process cannot prove a count.

`agent-config.ts` owns existing-file inspection and missing-only edits. `NativeConnection` carries the actual inference key when the active service requires one. `PublicConnection` carries only the authentication mode. Existing configured model strings remain exact, including aliases such as `[1m]`. A proposal applies only when a model field is absent. Every existing semantic value and comment survives Configure. Malformed input and detected concurrent edits return a result without changing the file.

## Native controller interface

`DesktopController.sessionApi()` returns `NativeSessionAuthority`. Its `snapshot()` and subscription emit safe `ServiceSnapshot` values. Its `dispatch()` accepts parsed `NativeIntent` commands. Its `connection()` resolves the private active `NativeConnection`. Renderer calls continue through `DesktopController.invoke()` and the separate `commandSchema`.

`DesktopController.activeConnection()` and `agentProposal()` support native copy, probe, and Configure handlers. The controller alone writes the native vault and account provenance. An explicit supplied token uses `persistence: "session"`. Native sign-out records `NativeCredentialProvenance` and does not reactivate a preserved plaintext CLI token. Account replacement keeps the existing account and gateway until authorization and the encrypted save succeed.

`ControllerOptions.homeDirectory` and `stateDirectory` inject config and service roots. Fixture controllers default their config home to their isolated `dataDirectory`; production wiring passes the real user home and shared native state directory. `openFolder` opens a computed agent configuration folder. `showUi` reveals the registered app for private CLI requests.

`CreatorLease` binds a process `sessionId` to `gatewayGeneration`. Each replacement gateway changes the generation. Explicit stop and drain commands require that lease. `ensure-running` and `update-runtime` carry only explicitly supplied overrides; CLI defaults do not reset a running service. Keyed overrides carry private `keys`, while public snapshots expose only `kind: "keyed"`.

`ManagedSession.read()` can observe a safe managed or legacy snapshot after the broker changes its binding. Its `invoke()` submits a private broker request. Each mutating controller command checks the current capabilities and gateway generation and returns `session-changed` or `unavailable` for an incompatible binding. A broker connection alone grants no rights over a legacy inference process.

`LoopbackRootUrl` permits only the root path. `LoopbackApiUrl` permits `/v1` with an optional trailing slash. A connection requires matching ports and permits equivalent loopback host spellings. URL parsing validates these types once without rewriting the user's configured spelling.

## Renderer state and commands

`DesktopSnapshot.connection` is the active safe connection. `source` identifies no binding, a native managed gateway, or a legacy CLI and its capabilities. `runtime` reports active runtime options. `authorization` tracks account replacement independently from the existing account. `agentConfigs` contains safe inspection results, and `lastConfigureResult` records the latest user-requested edit result.

`DesktopSettings.agentModelChoices` stores separate missing-field proposals for Claude Code, Codex, and OpenCode. `preferredModel` remains a test-request preference. Catalog browsing does not select a global agent model.

The renderer commands `select-agent-model`, `inspect-agent-config`, `configure-agent`, and `open-config-folder` each target one `ConfigurableAgent`. `curl` remains a copied request target and has no configurable file. Private provided-token and runtime-authentication commands cannot pass the renderer command schema.

The implementation supports current legacy observation and future CLI control through the native broker. A running older CLI keeps its original protocol until that process restarts with the updated source. `FEATURES.md` maps the native workflow checks, and `scripts/native-enrollment-smoke.ts` verifies real packaged enrollment without fixture mode.
