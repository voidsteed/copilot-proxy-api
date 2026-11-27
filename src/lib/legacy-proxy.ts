import { z } from "zod"

import type {
  CatalogModel,
  LegacyProbeOptions,
  LegacySession,
  LegacySnapshot,
  NativeConnection,
  OpenProxySessionOptions,
  ProxySession,
  ServiceSnapshot,
  ObservedActivity,
  UsageView,
} from "./proxy-contracts"

import { configuredProxyConnections } from "./agent-config"
import { isInferencePath } from "./inference-path"
import { nativeConnectionSchema, runtimeOptionsSchema } from "./proxy-contracts"

export interface LegacyReadOptions {
  refreshQuota?: boolean
}

export interface LegacyProxyControl extends LegacySession {
  read(options?: LegacyReadOptions): Promise<LegacySnapshot>
}

const MAX_BODY_BYTES = 4_000_000
const POLL_INTERVAL_MS = 2000
const REQUEST_TIMEOUT_MS = 3000
const QUOTA_TIMEOUT_MS = 12_000
const QUOTA_INTERVAL_MS = 60_000
const MAX_RETAINED_ACTIVITY = 200
type RefreshIntent = "background" | "explicit"
const textSchema = z.string().max(1000)
const modelCapabilitiesSchema = z.object({
  family: textSchema.nullish(),
  type: textSchema.nullish(),
  limits: z
    .object({
      max_context_window_tokens: z.number().nonnegative().nullish(),
      max_output_tokens: z.number().nonnegative().nullish(),
    })
    .nullish(),
  supports: z
    .object({
      tool_calls: z.boolean().nullish(),
      vision: z.boolean().nullish(),
      streaming: z.boolean().nullish(),
      adaptive_thinking: z.boolean().nullish(),
      reasoning_effort: z.array(textSchema).max(30).nullish(),
    })
    .nullish(),
})
const commonModelFields = {
  id: textSchema.min(1),
  capabilities: modelCapabilitiesSchema,
  supported_endpoints: z.array(textSchema).max(30).nullish(),
  preview: z.boolean().nullish(),
}
const upstreamModelSchema = z.object({
  ...commonModelFields,
  name: textSchema,
  vendor: textSchema,
})
const routedModelSchema = z.object({
  ...commonModelFields,
  object: z.literal("model"),
  display_name: textSchema,
  owned_by: textSchema,
})
const catalogModelSchema = z.union([upstreamModelSchema, routedModelSchema])
const catalogEnvelopeSchema = z.object({
  object: z.literal("list"),
  data: z.array(z.unknown()).max(2000),
})
const quotaDetailSchema = z
  .object({
    entitlement: z.number().nullish(),
    percent_remaining: z.number().nullish(),
    quota_remaining: z.number().nullish(),
    remaining: z.number().nullish(),
    unlimited: z.boolean().nullish(),
  })
  .refine(
    (quota) =>
      typeof quota.unlimited === "boolean"
      || typeof quota.entitlement === "number"
      || typeof quota.remaining === "number"
      || typeof quota.quota_remaining === "number",
    "A quota snapshot must declare unlimited or numeric balance fields",
  )
const legacyUsageEnvelopeSchema = z.object({
  copilot_plan: textSchema.min(1),
  quota_reset_date: textSchema.nullish(),
  quota_snapshots: z
    .record(textSchema, z.unknown())
    .refine(
      (quotas) =>
        Object.keys(quotas).length > 0 && Object.keys(quotas).length <= 30,
      "A Copilot usage response must contain quota snapshots",
    ),
})
const traceSchema = z.object({
  id: textSchema.min(1),
  method: z.string().max(20),
  path: z.string().max(2000),
  status: z.number().int().min(100).max(599),
  durationMs: z.number().nonnegative().nullish(),
  startedAt: z.iso.datetime({ offset: true }),
})
const traceListEnvelopeSchema = z.object({
  object: z.literal("list"),
  data: z.array(z.unknown()).max(2000),
})
async function boundedBody(response: Response): Promise<string> {
  if (
    !response.ok
    || Number(response.headers.get("content-length")) > MAX_BODY_BYTES
  ) {
    await response.body?.cancel()
    throw new Error("The legacy proxy response was not usable.")
  }
  const reader = response.body?.getReader()
  if (!reader) return ""
  const chunks: Array<Uint8Array> = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      const bytes = z.instanceof(Uint8Array).parse(chunk.value)
      size += bytes.byteLength
      if (size > MAX_BODY_BYTES)
        throw new Error("The legacy proxy response was too large.")
      chunks.push(bytes)
    }
    return Buffer.concat(chunks).toString("utf8")
  } finally {
    await reader.cancel().catch(() => {})
  }
}

async function legacyGet(options: {
  connection: NativeConnection
  path: string
  signal: AbortSignal
}): Promise<string> {
  const headers =
    options.connection.authentication.kind === "keyed" ?
      { authorization: `Bearer ${options.connection.authentication.key}` }
    : undefined
  return boundedBody(
    await fetch(new URL(options.path, options.connection.rootUrl), {
      method: "GET",
      headers,
      redirect: "error",
      signal: options.signal,
    }),
  )
}

function defaultModelEndpoints(type: string | null | undefined): Array<string> {
  return type === "embeddings" ?
      ["/embeddings"]
    : ["/chat/completions", "/responses"]
}

function modelSupports(
  supports: z.infer<typeof modelCapabilitiesSchema>["supports"],
): CatalogModel["supports"] {
  const features: CatalogModel["supports"] = []
  if (supports?.tool_calls) features.push("tools")
  if (supports?.vision) features.push("vision")
  if (supports?.streaming) features.push("streaming")
  if (supports?.adaptive_thinking || supports?.reasoning_effort?.length)
    features.push("reasoning")
  return features
}

function catalogView(
  models: Array<z.infer<typeof catalogModelSchema>>,
): Array<CatalogModel> {
  return models.map((model) => {
    const { capabilities } = model
    return {
      id: model.id,
      name: "name" in model ? model.name : model.display_name,
      vendor: "vendor" in model ? model.vendor : model.owned_by,
      contextWindow: capabilities.limits?.max_context_window_tokens ?? null,
      maxOutput: capabilities.limits?.max_output_tokens ?? null,
      supports: modelSupports(capabilities.supports),
      endpoints:
        model.supported_endpoints ?? defaultModelEndpoints(capabilities.type),
      preview: model.preview ?? false,
    }
  })
}

function parseCatalog(raw: unknown): Array<CatalogModel> {
  const envelope = catalogEnvelopeSchema.parse(raw)
  const models: Array<z.infer<typeof catalogModelSchema>> = []
  for (const item of envelope.data) {
    const parsed = catalogModelSchema.safeParse(item)
    if (parsed.success) models.push(parsed.data)
  }
  if (envelope.data.length > 0 && models.length === 0)
    throw new Error("The legacy proxy catalog contained no valid models.")
  return catalogView(models)
}

function usageView(
  usage: z.infer<typeof legacyUsageEnvelopeSchema>,
  fetchedAt: string,
): UsageView {
  const labels: Record<string, string> = {
    chat: "Chat",
    completions: "Completions",
    premium_interactions: "Premium requests",
  }
  const quotas: UsageView["quotas"] = []
  let validEntries = 0
  for (const [id, rawQuota] of Object.entries(usage.quota_snapshots)) {
    const parsed = quotaDetailSchema.safeParse(rawQuota)
    if (!parsed.success) continue
    validEntries++
    const quota = parsed.data
    const label = labels[id] ?? id.replaceAll("_", " ")
    if (quota.unlimited) {
      quotas.push({ kind: "unlimited", id, label })
      continue
    }
    const remaining = quota.remaining ?? quota.quota_remaining
    if (
      remaining === undefined
      || remaining === null
      || quota.entitlement === undefined
      || quota.entitlement === null
      || quota.entitlement < 0
    )
      continue
    quotas.push({
      kind: "limited",
      id,
      label,
      remaining: Math.max(0, remaining),
      limit: quota.entitlement,
      percentRemaining: Math.max(
        0,
        Math.min(
          100,
          quota.percent_remaining
            ?? (quota.entitlement > 0 ?
              (remaining / quota.entitlement) * 100
            : 0),
        ),
      ),
    })
  }
  if (validEntries === 0)
    throw new Error("The legacy proxy usage contained no valid quotas.")
  return {
    plan: usage.copilot_plan,
    resetAt: usage.quota_reset_date ?? null,
    fetchedAt,
    quotas,
  }
}

function observedActivity(
  traces: Array<z.infer<typeof traceSchema>>,
): Array<ObservedActivity> {
  return traces
    .filter((trace) => trace.method === "POST" && isInferencePath(trace.path))
    .map((trace) => ({
      ...trace,
      durationMs: trace.durationMs ?? 0,
      outcome: "observed",
      model: null,
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
    }))
}

function parseObservedActivity(raw: unknown): Array<ObservedActivity> {
  const envelope = traceListEnvelopeSchema.parse(raw)
  const traces: Array<z.infer<typeof traceSchema>> = []
  for (const item of envelope.data) {
    const parsed = traceSchema.safeParse(item)
    if (parsed.success) traces.push(parsed.data)
  }
  if (envelope.data.length > 0 && traces.length === 0)
    throw new Error("The legacy proxy activity log contained no valid entries.")
  return observedActivity(traces)
}

async function readLegacyLocal(options: {
  connection: NativeConnection
  signal: AbortSignal
  requireActivity: boolean
}) {
  const abort = new AbortController()
  const signal = AbortSignal.any([
    options.signal,
    abort.signal,
    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  ])
  const get = (path: string) => legacyGet({ ...options, path, signal })
  try {
    if ((await get("/")).trim() !== "Server running")
      throw new Error("This listener is not Copilot Proxy.")
    const catalog = get("/models").then((body) =>
      parseCatalog(JSON.parse(body)),
    )
    const activity = get("/debug/requests")
      .then((body) => parseObservedActivity(JSON.parse(body)))
      .catch((error: unknown) => {
        if (options.requireActivity) throw error
        return null
      })
    try {
      const [models, records] = await Promise.all([catalog, activity])
      return {
        catalog: models,
        activity: records,
        observedAt: new Date().toISOString(),
      }
    } finally {
      abort.abort()
      await Promise.allSettled([catalog, activity])
    }
  } finally {
    abort.abort()
  }
}

async function readLegacyUsage(options: {
  connection: NativeConnection
  signal: AbortSignal
}): Promise<UsageView> {
  const signal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(QUOTA_TIMEOUT_MS),
  ])
  const body = await legacyGet({ ...options, path: "/usage", signal })
  return usageView(
    legacyUsageEnvelopeSchema.parse(JSON.parse(body)),
    new Date().toISOString(),
  )
}

export async function probeLegacyProxy(
  options: LegacyProbeOptions,
): Promise<LegacyProxyControl | null> {
  const connection = nativeConnectionSchema.parse(options.connection)
  const abort = new AbortController()
  const signal =
    options.signal ?
      AbortSignal.any([options.signal, abort.signal])
    : abort.signal
  let local: Awaited<ReturnType<typeof readLegacyLocal>>
  try {
    local = await readLegacyLocal({ connection, signal, requireActivity: true })
  } catch {
    abort.abort()
    return null
  }
  if (signal.aborted || local.activity === null) {
    abort.abort()
    return null
  }
  const snapshot: LegacySnapshot = {
    kind: "legacy",
    connection: {
      rootUrl: connection.rootUrl,
      apiUrl: connection.apiUrl,
      authentication: { kind: connection.authentication.kind },
    },
    status: "reachable",
    account: { kind: "external-unverified" },
    capabilities: {
      kind: "legacy",
      runtime: "read-only",
      account: "unverified",
      activity: "observed",
      drain: false,
    },
    catalog: local.catalog,
    usage: null,
    activity: local.activity,
    totals: {
      requests: null,
      errors: null,
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
    },
    observedAt: local.observedAt,
  }
  return new LegacyProxySession({ connection, signal, abort }, snapshot)
}

class LegacyProxySession implements LegacyProxyControl {
  readonly kind = "legacy"
  readonly #options: {
    connection: NativeConnection
    signal: AbortSignal
    abort: AbortController
  }
  #snapshot: LegacySnapshot
  readonly #retained = new Map<string, ObservedActivity>()
  readonly #listeners = new Set<(snapshot: LegacySnapshot) => void>()
  #pendingLocal: Promise<void> | undefined
  #pendingQuota: Promise<void> | undefined
  #quotaAttemptedAt: number | undefined
  #timer: ReturnType<typeof setInterval> | undefined

  constructor(
    options: {
      connection: NativeConnection
      signal: AbortSignal
      abort: AbortController
    },
    snapshot: LegacySnapshot,
  ) {
    this.#options = options
    this.#snapshot = { ...snapshot, activity: this.#retain(snapshot.activity) }
    void this.#readQuota("background")
  }

  #retain(activity: Array<ObservedActivity>) {
    for (const record of activity)
      this.#retained.set(JSON.stringify([record.id, record.startedAt]), record)
    const records = [...this.#retained.values()]
      .sort(
        (left, right) =>
          Date.parse(right.startedAt) - Date.parse(left.startedAt),
      )
      .slice(0, MAX_RETAINED_ACTIVITY)
    this.#retained.clear()
    for (const record of records)
      this.#retained.set(JSON.stringify([record.id, record.startedAt]), record)
    return records
  }

  #publish(): void {
    for (const listener of this.#listeners) {
      if (this.#options.signal.aborted) break
      listener(this.#snapshot)
    }
  }

  #readLocal(): Promise<void> {
    if (this.#options.signal.aborted) return Promise.resolve()
    this.#pendingLocal ??= (async () => {
      try {
        const next = await readLegacyLocal({
          ...this.#options,
          requireActivity: false,
        })
        if (!this.#options.signal.aborted)
          this.#snapshot = {
            ...this.#snapshot,
            status: "reachable",
            catalog: next.catalog,
            activity:
              next.activity === null ?
                this.#snapshot.activity
              : this.#retain(next.activity),
            observedAt: next.observedAt,
          }
      } catch {
        if (!this.#options.signal.aborted)
          this.#snapshot = { ...this.#snapshot, status: "unreachable" }
      }
      this.#publish()
    })().finally(() => {
      this.#pendingLocal = undefined
    })
    return this.#pendingLocal
  }

  #readQuota(intent: RefreshIntent): Promise<void> {
    if (this.#options.signal.aborted) return Promise.resolve()
    if (this.#pendingQuota) return this.#pendingQuota
    const attemptedAt = Date.now()
    if (
      intent === "background"
      && this.#quotaAttemptedAt !== undefined
      && attemptedAt - this.#quotaAttemptedAt < QUOTA_INTERVAL_MS
    )
      return Promise.resolve()
    this.#quotaAttemptedAt = attemptedAt
    this.#pendingQuota = (async () => {
      try {
        const usage = await readLegacyUsage(this.#options)
        if (!this.#options.signal.aborted) {
          this.#snapshot = { ...this.#snapshot, usage }
          this.#publish()
        }
      } catch {
        return
      }
    })().finally(() => {
      this.#pendingQuota = undefined
    })
    return this.#pendingQuota
  }

  async read(options?: LegacyReadOptions): Promise<LegacySnapshot> {
    await Promise.all([
      this.#readLocal(),
      this.#readQuota(options?.refreshQuota ? "explicit" : "background"),
    ])
    return this.#snapshot
  }

  subscribe(listener: (snapshot: LegacySnapshot) => void): () => void {
    if (this.#options.signal.aborted) return () => {}
    this.#listeners.add(listener)
    this.#timer ??= setInterval(() => {
      void this.#readLocal()
      void this.#readQuota("background")
    }, POLL_INTERVAL_MS)
    this.#timer.unref()
    listener(this.#snapshot)
    return () => {
      this.#listeners.delete(listener)
      if (this.#listeners.size === 0 && this.#timer) {
        clearInterval(this.#timer)
        this.#timer = undefined
      }
    }
  }

  async release(): Promise<void> {
    this.#options.abort.abort()
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = undefined
    this.#listeners.clear()
    await Promise.allSettled([this.#pendingLocal, this.#pendingQuota])
  }
}

async function legacyCandidates(
  options: Omit<OpenProxySessionOptions, "intent">,
  intent?: OpenProxySessionOptions["intent"],
): Promise<Array<NativeConnection>> {
  const savedRuntime = runtimeOptionsSchema.parse(
    options.discovery.savedRuntime,
  )
  const supplied = await configuredProxyConnections(options.homeDirectory)
  const rootUrl = `http://localhost:${intent?.explicit.port ?? savedRuntime.port}`
  const defaults = nativeConnectionSchema.parse({
    rootUrl,
    apiUrl: `${rootUrl}/v1`,
    authentication: { kind: "none" },
  })
  const candidates = [...supplied, defaults]
  for (const view of options.discovery.configuredAgents) {
    const parsed = nativeConnectionSchema.safeParse({
      rootUrl: view.rootUrl ?? (view.apiUrl ? new URL(view.apiUrl).origin : ""),
      apiUrl:
        view.apiUrl
        ?? (view.rootUrl ? `${view.rootUrl.replace(/\/$/, "")}/v1` : ""),
      authentication: { kind: "none" },
    })
    if (parsed.success) candidates.push(parsed.data)
  }
  if (intent?.explicit.authentication?.kind === "keyed") {
    for (const key of intent.explicit.authentication.keys)
      candidates.push(
        nativeConnectionSchema.parse({
          ...defaults,
          authentication: { kind: "keyed", key },
        }),
      )
  }
  return candidates
}

export async function discoverLegacySession(
  options: Omit<OpenProxySessionOptions, "intent">,
  intent?: OpenProxySessionOptions["intent"],
): Promise<ProxySession> {
  const candidates = await legacyCandidates(options, intent)
  const attempted = new Set<string>()
  for (const connection of candidates) {
    if (
      intent?.explicit.port !== undefined
      && Number(new URL(connection.rootUrl).port || 80) !== intent.explicit.port
    )
      continue
    const identity = JSON.stringify(connection)
    if (attempted.has(identity)) continue
    attempted.add(identity)
    const session = await probeLegacyProxy({ connection })
    if (session) return session
  }
  return { kind: "standalone" }
}

export async function legacyIntentCompatible(
  intent: OpenProxySessionOptions["intent"],
  snapshot: Extract<ServiceSnapshot, { kind: "legacy" }>,
): Promise<boolean> {
  if (snapshot.status !== "reachable") return false
  if (intent.credential.kind === "provided-token") return false
  const { port, authentication, ...other } = intent.explicit
  if (Object.keys(other).length > 0) return false
  if (
    port !== undefined
    && port !== Number(new URL(snapshot.connection.rootUrl).port || 80)
  )
    return false
  if (authentication === undefined) return true
  if (authentication.kind !== snapshot.connection.authentication.kind)
    return false
  if (authentication.kind === "none") return true
  for (const key of authentication.keys) {
    const proof = await probeLegacyProxy({
      connection: nativeConnectionSchema.parse({
        ...snapshot.connection,
        authentication: { kind: "keyed", key },
      }),
    })
    if (!proof) return false
    await proof.release()
  }
  return true
}
