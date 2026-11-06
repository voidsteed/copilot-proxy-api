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
import { nativeConnectionSchema, runtimeOptionsSchema } from "./proxy-contracts"

const MAX_BODY_BYTES = 4_000_000
const POLL_INTERVAL_MS = 2000
const REQUEST_TIMEOUT_MS = 3000
const QUOTA_TIMEOUT_MS = 12_000
const QUOTA_INTERVAL_MS = 60_000
const MAX_RETAINED_ACTIVITY = 200
type RefreshIntent = "background" | "explicit"
const textSchema = z.string().max(1000)
const modelCapabilitiesSchema = z.object({
  family: textSchema,
  type: textSchema,
  limits: z
    .object({
      max_context_window_tokens: z.number().nonnegative().optional(),
      max_output_tokens: z.number().nonnegative().optional(),
    })
    .default({}),
  supports: z.object({
    tool_calls: z.boolean().optional(),
    vision: z.boolean().optional(),
    streaming: z.boolean().optional(),
    adaptive_thinking: z.boolean().optional(),
    reasoning_effort: z.array(textSchema).max(30).optional(),
  }),
})
const commonModelFields = {
  id: textSchema.min(1),
  capabilities: modelCapabilitiesSchema,
  supported_endpoints: z.array(textSchema).max(30).optional(),
  preview: z.boolean().default(false),
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
const catalogSchema = z.object({
  object: z.literal("list"),
  data: z.array(z.union([upstreamModelSchema, routedModelSchema])).max(2000),
})
const quotaDetailSchema = z.object({
  entitlement: z.number().nonnegative().optional(),
  percent_remaining: z.number().optional(),
  quota_remaining: z.number().optional(),
  remaining: z.number().optional(),
  unlimited: z.boolean(),
})
const legacyUsageSchema = z.object({
  copilot_plan: textSchema.min(1),
  quota_reset_date: textSchema.nullish(),
  quota_snapshots: z
    .record(textSchema, quotaDetailSchema)
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
  durationMs: z.number().nonnegative(),
  startedAt: z.iso.datetime({ offset: true }),
})
const traceListSchema = z.object({
  object: z.literal("list"),
  data: z.array(traceSchema).max(2000),
})
const inferencePaths = new Set([
  "/chat/completions",
  "/v1/chat/completions",
  "/responses",
  "/v1/responses",
  "/messages",
  "/v1/messages",
  "/embeddings",
  "/v1/embeddings",
])

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

function catalogView(
  catalog: z.infer<typeof catalogSchema>,
): Array<CatalogModel> {
  return catalog.data.map((model) => {
    const supports: CatalogModel["supports"] = []
    if (model.capabilities.supports.tool_calls) supports.push("tools")
    if (model.capabilities.supports.vision) supports.push("vision")
    if (model.capabilities.supports.streaming) supports.push("streaming")
    if (
      model.capabilities.supports.adaptive_thinking
      || model.capabilities.supports.reasoning_effort?.length
    )
      supports.push("reasoning")
    return {
      id: model.id,
      name: "name" in model ? model.name : model.display_name,
      vendor: "vendor" in model ? model.vendor : model.owned_by,
      contextWindow:
        model.capabilities.limits.max_context_window_tokens ?? null,
      maxOutput: model.capabilities.limits.max_output_tokens ?? null,
      supports,
      endpoints: model.supported_endpoints ?? [],
      preview: model.preview,
    }
  })
}

function usageView(
  usage: z.infer<typeof legacyUsageSchema>,
  fetchedAt: string,
): UsageView {
  const labels: Record<string, string> = {
    chat: "Chat",
    completions: "Completions",
    premium_interactions: "Premium requests",
  }
  const quotas: UsageView["quotas"] = []
  for (const [id, quota] of Object.entries(usage.quota_snapshots)) {
    const label = labels[id] ?? id.replaceAll("_", " ")
    if (quota.unlimited) {
      quotas.push({ kind: "unlimited", id, label })
      continue
    }
    const remaining = quota.remaining ?? quota.quota_remaining
    if (remaining === undefined || quota.entitlement === undefined) continue
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
  return {
    plan: usage.copilot_plan,
    resetAt: usage.quota_reset_date ?? null,
    fetchedAt,
    quotas,
  }
}

function observedActivity(
  traces: z.infer<typeof traceListSchema>,
): Array<ObservedActivity> {
  return traces.data
    .filter(
      (trace) => trace.method === "POST" && inferencePaths.has(trace.path),
    )
    .map((trace) => ({
      ...trace,
      outcome: "observed",
      model: null,
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
    }))
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
      catalogView(catalogSchema.parse(JSON.parse(body))),
    )
    const activity = get("/debug/requests")
      .then((body) => observedActivity(traceListSchema.parse(JSON.parse(body))))
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
    legacyUsageSchema.parse(JSON.parse(body)),
    new Date().toISOString(),
  )
}

export async function probeLegacyProxy(
  options: LegacyProbeOptions,
): Promise<LegacySession | null> {
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

class LegacyProxySession implements LegacySession {
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

  async read(): Promise<LegacySnapshot> {
    await Promise.all([this.#readLocal(), this.#readQuota("explicit")])
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
