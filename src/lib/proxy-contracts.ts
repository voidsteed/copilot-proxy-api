import { z } from "zod"

export const agentTargetSchema = z.enum([
  "claude-code",
  "codex",
  "opencode",
  "curl",
])
export type AgentTarget = z.infer<typeof agentTargetSchema>

export const configurableAgentSchema = agentTargetSchema.exclude(["curl"])
export type ConfigurableAgent = z.infer<typeof configurableAgentSchema>

function parsedUrl(value: string): URL | null {
  return URL.canParse(value) ? new URL(value) : null
}

const loopbackUrlSchema = z.url().refine((value) => {
  const url = parsedUrl(value)
  return (
    url !== null
    && url.protocol === "http:"
    && ["[::1]", "127.0.0.1", "localhost"].includes(url.hostname)
    && url.username === ""
    && url.password === ""
    && url.search === ""
    && url.hash === ""
  )
}, "A proxy connection must use an HTTP loopback URL")

export const loopbackRootUrlSchema = loopbackUrlSchema
  .refine(
    (value) => parsedUrl(value)?.pathname === "/",
    "Use the proxy root URL",
  )
  .brand<"LoopbackRootUrl">()
export const loopbackApiUrlSchema = loopbackUrlSchema
  .refine(
    (value) => ["/v1", "/v1/"].includes(parsedUrl(value)?.pathname ?? ""),
    "Use the proxy /v1 API URL",
  )
  .brand<"LoopbackApiUrl">()
export type LoopbackRootUrl = z.infer<typeof loopbackRootUrlSchema>
export type LoopbackApiUrl = z.infer<typeof loopbackApiUrlSchema>

const apiKeySchema = z.string().min(1).max(4096)

export const publicAuthenticationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("keyed") }).strict(),
])

export const nativeAuthenticationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("keyed"), key: apiKeySchema }).strict(),
])

const connectionUrlFields = {
  rootUrl: loopbackRootUrlSchema,
  apiUrl: loopbackApiUrlSchema,
}

function matchingConnectionPort(connection: {
  rootUrl: string
  apiUrl: string
}): boolean {
  const rootUrl = parsedUrl(connection.rootUrl)
  const apiUrl = parsedUrl(connection.apiUrl)
  return rootUrl !== null && apiUrl !== null && rootUrl.port === apiUrl.port
}

export const publicConnectionSchema = z
  .object({
    ...connectionUrlFields,
    authentication: publicAuthenticationSchema,
  })
  .strict()
  .refine(
    matchingConnectionPort,
    "Proxy root and API URLs must use the same port",
  )
export type PublicConnection = z.infer<typeof publicConnectionSchema>

export const nativeConnectionSchema = z
  .object({
    ...connectionUrlFields,
    authentication: nativeAuthenticationSchema,
  })
  .strict()
  .refine(
    matchingConnectionPort,
    "Proxy root and API URLs must use the same port",
  )
export type NativeConnection = z.infer<typeof nativeConnectionSchema>

export const agentModelSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("configured"),
      exact: z.string().min(1).max(1000),
      catalogId: z.string().nullable(),
    })
    .strict(),
  z
    .object({ kind: z.literal("proposed"), catalogId: z.string().min(1) })
    .strict(),
  z.object({ kind: z.literal("missing") }).strict(),
])
export type AgentModel = z.infer<typeof agentModelSchema>

export const agentModelChoicesSchema = z
  .object({
    "claude-code": z.string().max(200).nullable(),
    codex: z.string().max(200).nullable(),
    opencode: z.string().max(200).nullable(),
  })
  .strict()
export type AgentModelChoices = z.infer<typeof agentModelChoicesSchema>

export const agentConfigViewSchema = z
  .object({
    target: configurableAgentSchema,
    path: z.string(),
    status: z.enum(["configured", "missing", "conflicting", "invalid"]),
    model: agentModelSchema,
    rootUrl: z.string().nullable(),
    apiUrl: z.string().nullable(),
    authenticationPresent: z.boolean(),
    missingFields: z.array(z.string()),
    conflictFields: z.array(z.string()),
    message: z.string().optional(),
  })
  .strict()
export type AgentConfigView = z.infer<typeof agentConfigViewSchema>

export const configureResultSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("unchanged"), view: agentConfigViewSchema })
    .strict(),
  z
    .object({
      kind: z.literal("added"),
      fields: z.array(z.string()),
      view: agentConfigViewSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("conflict"),
      fields: z.array(z.string()),
      view: agentConfigViewSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("invalid"),
      message: z.string(),
      view: agentConfigViewSchema,
    })
    .strict(),
])
export type ConfigureResult = z.infer<typeof configureResultSchema>

export const modelSchema = z.object({
  id: z.string(),
  name: z.string(),
  vendor: z.string(),
  contextWindow: z.number().nullable(),
  maxOutput: z.number().nullable(),
  supports: z.array(z.enum(["tools", "vision", "reasoning", "streaming"])),
  endpoints: z.array(z.string()),
  preview: z.boolean(),
})
export type CatalogModel = z.infer<typeof modelSchema>

export const quotaSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("limited"),
    id: z.string(),
    label: z.string(),
    remaining: z.number(),
    limit: z.number(),
    percentRemaining: z.number().min(0).max(100),
  }),
  z.object({ kind: z.literal("unlimited"), id: z.string(), label: z.string() }),
])

export const usageSchema = z.object({
  plan: z.string(),
  resetAt: z.string().nullable(),
  fetchedAt: z.string(),
  quotas: z.array(quotaSchema),
})
export type UsageView = z.infer<typeof usageSchema>

const requestFields = {
  id: z.string(),
  startedAt: z.string(),
  method: z.string(),
  path: z.string(),
  status: z.number(),
  durationMs: z.number().nonnegative(),
}

export const completedActivitySchema = z.object({
  ...requestFields,
  model: z.string().nullable(),
  outcome: z.enum(["completed", "failed", "cancelled"]),
  inputTokens: z.number().nonnegative().nullable(),
  outputTokens: z.number().nonnegative().nullable(),
  cachedTokens: z.number().nonnegative().nullable(),
})
export type CompletedActivity = z.infer<typeof completedActivitySchema>

export const observedActivitySchema = z.object({
  ...requestFields,
  outcome: z.literal("observed"),
  model: z.null(),
  inputTokens: z.null(),
  outputTokens: z.null(),
  cachedTokens: z.null(),
})
export type ObservedActivity = z.infer<typeof observedActivitySchema>

export const activitySchema = z.discriminatedUnion("outcome", [
  completedActivitySchema,
  observedActivitySchema,
])
export type ActivityRecord = z.infer<typeof activitySchema>

export const totalsSchema = z.object({
  requests: z.number().nonnegative().nullable(),
  errors: z.number().nonnegative().nullable(),
  inputTokens: z.number().nonnegative().nullable(),
  outputTokens: z.number().nonnegative().nullable(),
  cachedTokens: z.number().nonnegative().nullable(),
})
export type ProxyTotals = z.infer<typeof totalsSchema>

export const managedCapabilitiesSchema = z.object({
  kind: z.literal("managed"),
  runtime: z.literal("managed"),
  account: z.literal("managed"),
  activity: z.literal("completed"),
  drain: z.literal(true),
})
export const legacyCapabilitiesSchema = z.object({
  kind: z.literal("legacy"),
  runtime: z.literal("read-only"),
  account: z.literal("unverified"),
  activity: z.literal("observed"),
  drain: z.literal(false),
})
export const proxyCapabilitiesSchema = z.discriminatedUnion("kind", [
  managedCapabilitiesSchema,
  legacyCapabilitiesSchema,
])
export type ProxyCapabilities = z.infer<typeof proxyCapabilitiesSchema>

export const sessionIdSchema = z.string().min(1).max(200).brand<"SessionId">()
export type SessionId = z.infer<typeof sessionIdSchema>
export const gatewayGenerationSchema = z
  .number()
  .int()
  .nonnegative()
  .brand<"GatewayGeneration">()
export type GatewayGeneration = z.infer<typeof gatewayGenerationSchema>

export const creatorLeaseSchema = z
  .object({
    sessionId: sessionIdSchema,
    gatewayGeneration: gatewayGenerationSchema,
  })
  .strict()
export type CreatorLease = z.infer<typeof creatorLeaseSchema>

export const proxySourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("native-managed"),
      sessionId: sessionIdSchema,
      gatewayGeneration: gatewayGenerationSchema,
      capabilities: managedCapabilitiesSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("legacy-cli"),
      status: z.enum(["reachable", "unreachable"]),
      observedAt: z.string(),
      capabilities: legacyCapabilitiesSchema,
    })
    .strict(),
])
export type ProxySource = z.infer<typeof proxySourceSchema>

export const runtimeOptionsSchema = z
  .object({
    port: z.number().int().min(1024).max(65535),
    accountType: z.enum(["individual", "business", "enterprise"]),
    manualApprove: z.boolean(),
    rateLimitSeconds: z.number().nonnegative().nullable(),
    rateLimitWait: z.boolean(),
    responsesContextTrim: z.boolean(),
    proxyFromEnvironment: z.boolean(),
  })
  .strict()
export type RuntimeOptions = z.infer<typeof runtimeOptionsSchema>

export const runtimeAuthenticationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({ kind: z.literal("keyed"), keys: z.array(apiKeySchema).min(1) })
    .strict(),
])

export const runtimeOverridesSchema = runtimeOptionsSchema.partial().extend({
  authentication: runtimeAuthenticationSchema.optional(),
})
export type RuntimeOverrides = z.infer<typeof runtimeOverridesSchema>

export const authorizationIdSchema = z
  .string()
  .min(1)
  .max(200)
  .brand<"AuthorizationId">()
export type AuthorizationId = z.infer<typeof authorizationIdSchema>

export const authorizationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("idle") }).strict(),
  z
    .object({ kind: z.literal("connecting"), id: authorizationIdSchema })
    .strict(),
  z
    .object({
      kind: z.literal("awaiting"),
      id: authorizationIdSchema,
      code: z.string(),
      verificationUri: z.url(),
      expiresAt: z.iso.datetime({ offset: true }),
    })
    .strict(),
  z
    .object({ kind: z.literal("validating"), id: authorizationIdSchema })
    .strict(),
  z
    .object({
      kind: z.literal("error"),
      id: authorizationIdSchema,
      message: z.string(),
    })
    .strict(),
])
export type Authorization = z.infer<typeof authorizationSchema>

export const nativeAccountSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("signed-out") }).strict(),
  z
    .object({
      kind: z.literal("signed-in"),
      login: z.string(),
      name: z.string().nullable(),
      plan: z.string(),
      credentialSource: z.enum(["native-vault", "session-override"]),
      epoch: z.number().int().nonnegative(),
    })
    .strict(),
])

export const nativeGatewaySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stopped") }),
  z.object({ kind: z.literal("starting") }),
  z.object({
    kind: z.literal("running"),
    connection: publicConnectionSchema,
    startedAt: z.string(),
  }),
  z.object({
    kind: z.literal("draining"),
    inFlight: z.number().int().nonnegative(),
  }),
  z.object({ kind: z.literal("stopping") }),
  z.object({ kind: z.literal("error"), message: z.string() }),
])

export const nativeSnapshotSchema = z.object({
  kind: z.literal("managed"),
  sessionId: sessionIdSchema,
  gatewayGeneration: gatewayGenerationSchema,
  revision: z.number().int().nonnegative(),
  account: nativeAccountSchema,
  authorization: authorizationSchema,
  storageMode: z.enum(["encrypted", "session-only"]),
  gateway: nativeGatewaySchema,
  capabilities: managedCapabilitiesSchema,
  options: runtimeOptionsSchema,
  authentication: publicAuthenticationSchema,
  catalog: z.array(modelSchema),
  usage: usageSchema.nullable(),
  activity: z.array(completedActivitySchema),
  totals: totalsSchema,
})
export type NativeSnapshot = z.infer<typeof nativeSnapshotSchema>

export const legacySnapshotSchema = z.object({
  kind: z.literal("legacy"),
  connection: publicConnectionSchema,
  status: z.enum(["reachable", "unreachable"]),
  account: z.object({ kind: z.literal("external-unverified") }),
  capabilities: legacyCapabilitiesSchema,
  catalog: z.array(modelSchema),
  usage: usageSchema.nullable(),
  activity: z.array(observedActivitySchema),
  totals: totalsSchema,
  observedAt: z.string(),
})
export type LegacySnapshot = z.infer<typeof legacySnapshotSchema>
export const serviceSnapshotSchema = z.discriminatedUnion("kind", [
  nativeSnapshotSchema,
  legacySnapshotSchema,
])
export type ServiceSnapshot = z.infer<typeof serviceSnapshotSchema>

export const cliStartCredentialSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("native-saved-account") }).strict(),
  z
    .object({
      kind: z.literal("provided-token"),
      value: z.string().min(1).max(4096),
      persistence: z.literal("session"),
    })
    .strict(),
])
export type CliStartCredential = z.infer<typeof cliStartCredentialSchema>

export const nativeCredentialProvenanceSchema = z
  .object({
    kind: z.literal("native-authority"),
    account: z.enum(["saved", "signed-out"]),
  })
  .strict()
export type NativeCredentialProvenance = z.infer<
  typeof nativeCredentialProvenanceSchema
>

const drainFields = {
  expected: creatorLeaseSchema,
  timeoutMs: z.number().int().min(1).max(60_000).default(15_000),
}

export const nativeIntentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ensure-running"),
      explicit: runtimeOverridesSchema,
      credential: cliStartCredentialSchema,
    })
    .strict(),
  z.object({ kind: z.literal("stop-gateway"), ...drainFields }).strict(),
  z.object({ kind: z.literal("drain-gateway"), ...drainFields }).strict(),
  z.object({ kind: z.literal("authorize") }).strict(),
  z
    .object({
      kind: z.literal("cancel-authorization"),
      authorizationId: authorizationIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("authorize-with-token"),
      token: z.string().min(1).max(4096),
      persistence: z.literal("session"),
    })
    .strict(),
  z.object({ kind: z.literal("sign-out") }).strict(),
  z
    .object({
      kind: z.literal("update-runtime"),
      explicit: runtimeOverridesSchema,
    })
    .strict(),
  z.object({ kind: z.literal("refresh") }).strict(),
  z.object({ kind: z.literal("clear-activity") }).strict(),
  z.object({ kind: z.literal("show-ui") }).strict(),
])
export type NativeIntent = z.infer<typeof nativeIntentSchema>

export const controlResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("applied"),
    snapshot: nativeSnapshotSchema,
    createdGateway: creatorLeaseSchema.nullable(),
  }),
  z.object({
    kind: z.literal("session-changed"),
    snapshot: serviceSnapshotSchema,
  }),
  z.object({ kind: z.literal("unavailable"), message: z.string() }),
])
export type ControlResult = z.infer<typeof controlResultSchema>

export interface NativeSessionAuthority {
  snapshot(): ServiceSnapshot
  dispatch(intent: NativeIntent): Promise<ControlResult>
  connection(): NativeConnection | null
  subscribe(listener: (snapshot: ServiceSnapshot) => void): () => void
}

export interface ManagedSession {
  kind: "managed"
  lifecycle:
    | {
        kind: "creator"
        lease: CreatorLease
        stopCreatedGateway(): Promise<ControlResult>
      }
    | { kind: "observer" }
  read(): Promise<ServiceSnapshot>
  invoke(intent: NativeIntent): Promise<ControlResult>
  connection(): Promise<NativeConnection | null>
  subscribe(listener: (snapshot: ServiceSnapshot) => void): () => void
  release(): Promise<void>
}

export interface LegacySession {
  kind: "legacy"
  read(): Promise<LegacySnapshot>
  subscribe(listener: (snapshot: LegacySnapshot) => void): () => void
  release(): Promise<void>
}

export type ProxySession =
  | ManagedSession
  | LegacySession
  | { kind: "standalone" }
  | { kind: "unavailable"; message: string }

export interface ProxyDiscovery {
  configuredAgents: Array<AgentConfigView>
  savedRuntime: RuntimeOptions
}

export interface OpenProxySessionOptions {
  homeDirectory: string
  stateDirectory: string
  intent: Extract<NativeIntent, { kind: "ensure-running" }>
  discovery: ProxyDiscovery
}

export interface HostProxySessionOptions {
  stateDirectory: string
  authority: NativeSessionAuthority
  installation?: { executablePath: string; packageFingerprint: string }
  showUi(): void | Promise<void>
}

export interface InspectAgentConfigsOptions {
  homeDirectory: string
  connection: NativeConnection | null
  catalog: Array<CatalogModel>
  proposals: AgentModelChoices
}

export interface ConfigureMissingAgentOptions {
  homeDirectory: string
  target: ConfigurableAgent
  connection: NativeConnection
  catalog: Array<CatalogModel>
  proposal: Extract<AgentModel, { kind: "proposed" }> | null
}

export interface LegacyProbeOptions {
  connection: NativeConnection
  signal?: AbortSignal
}
