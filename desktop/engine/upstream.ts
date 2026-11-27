import { z } from "zod"

import type {
  Model,
  ModelsResponse,
} from "../../src/services/copilot/get-models"
import type {
  DesktopModel,
  DesktopSettings,
  DesktopSnapshot,
} from "../shared/contracts"

import { copilotHeaders, githubHeaders } from "../../src/lib/api-config"
import { DEFAULT_VSCODE_VERSION } from "../../src/services/get-vscode-version"

const safeText = z.string().max(256)
const modelId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\w./:-]+$/)
const tokenSchema = z.object({
  token: z.string().min(1).max(16_384),
  refresh_in: z.number().positive().default(1500),
  expires_at: z.number().optional(),
})

function omitNullish<T extends Record<string, unknown>>(
  record: T,
): { [K in keyof T]?: Exclude<T[K], null | undefined> } {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (value !== null && value !== undefined) result[key] = value
  }
  return result as { [K in keyof T]?: Exclude<T[K], null | undefined> }
}

const visionLimitsSchema = z
  .object({
    max_prompt_image_size: z.number().nonnegative().nullish(),
    max_prompt_images: z.number().nonnegative().nullish(),
    supported_media_types: z.array(z.string().max(120)).max(50).nullish(),
  })
  .transform(omitNullish)

const modelLimitsSchema = z
  .object({
    max_context_window_tokens: z.number().nonnegative().nullish(),
    max_output_tokens: z.number().nonnegative().nullish(),
    max_prompt_tokens: z.number().nonnegative().nullish(),
    max_inputs: z.number().nonnegative().nullish(),
    vision: visionLimitsSchema.nullish(),
  })
  .transform(omitNullish)

const modelSupportsSchema = z
  .object({
    tool_calls: z.boolean().nullish(),
    parallel_tool_calls: z.boolean().nullish(),
    dimensions: z.boolean().nullish(),
    streaming: z.boolean().nullish(),
    structured_outputs: z.boolean().nullish(),
    vision: z.boolean().nullish(),
    adaptive_thinking: z.boolean().nullish(),
    reasoning_effort: z.array(z.string()).nullish(),
  })
  .transform(omitNullish)

const policySchema = z.object({
  state: z.string(),
  terms: z
    .string()
    .nullish()
    .transform((value) => value ?? ""),
})

export const upstreamModelSchema = z
  .object({
    id: modelId,
    name: safeText,
    vendor: safeText.nullish().transform((value) => value ?? "Unknown"),
    object: z
      .string()
      .nullish()
      .transform((value) => value ?? "model"),
    version: z
      .string()
      .nullish()
      .transform((value) => value ?? ""),
    preview: z
      .boolean()
      .nullish()
      .transform((value) => value ?? false),
    model_picker_enabled: z
      .boolean()
      .nullish()
      .transform((value) => value ?? true),
    supported_endpoints: z.array(z.string().max(80)).max(30).nullish(),
    capabilities: z.object({
      family: z
        .string()
        .nullish()
        .transform((value) => value ?? ""),
      object: z
        .string()
        .nullish()
        .transform((value) => value ?? "model_capabilities"),
      tokenizer: z
        .string()
        .nullish()
        .transform((value) => value ?? ""),
      type: z
        .string()
        .nullish()
        .transform((value) => value ?? "chat"),
      limits: modelLimitsSchema.nullish().transform((value) => value ?? {}),
      supports: modelSupportsSchema.nullish().transform((value) => value ?? {}),
    }),
    policy: policySchema.nullish(),
  })
  .transform(
    ({ supported_endpoints, policy, ...rest }): Model => ({
      ...rest,
      ...(supported_endpoints ? { supported_endpoints } : {}),
      ...(policy ? { policy } : {}),
    }),
  )

export const upstreamCatalogSchema = z
  .object({
    object: z
      .string()
      .nullish()
      .transform((value) => value ?? "list"),
    data: z.array(z.unknown()).max(2000),
  })
  .transform((catalog, ctx): ModelsResponse => {
    const data: Array<Model> = []
    for (const item of catalog.data) {
      const parsed = upstreamModelSchema.safeParse(item)
      if (parsed.success) data.push(parsed.data)
    }
    if (catalog.data.length > 0 && data.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["data"],
        message: "Catalog contains no valid models",
      })
      return z.NEVER
    }
    return { object: catalog.object, data }
  })

const quotaDetailSchema = z.object({
  entitlement: z.number().nullish(),
  percent_remaining: z.number().nullish(),
  quota_remaining: z.number().nullish(),
  remaining: z.number().nullish(),
  unlimited: z
    .boolean()
    .nullish()
    .transform((value) => value ?? false),
})

const upstreamUsageSchema = z.object({
  copilot_plan: safeText.nullish().transform((value) => value ?? "Copilot"),
  quota_reset_date: z.string().max(80).nullish(),
  quota_snapshots: z
    .record(z.string().max(80), z.unknown())
    .nullish()
    .transform((value) => value ?? {}),
})

export const fixtureOriginSchema = z.url().refine((value) => {
  const url = new URL(value)
  return (
    url.protocol === "http:"
    && url.hostname === "127.0.0.1"
    && url.pathname === "/"
    && !url.search
    && !url.hash
    && !url.username
    && !url.password
    && Boolean(url.port)
  )
}, "Fixture origin must be a numeric loopback HTTP origin")

const upstreamOrigins = new Set([
  "https://github.com",
  "https://api.github.com",
  "https://api.githubcopilot.com",
  "https://api.business.githubcopilot.com",
  "https://api.enterprise.githubcopilot.com",
])

export function mapUpstreamUrl(value: string, fixtureOrigin?: string): string {
  if (!fixtureOrigin) return value
  const url = new URL(value)
  if (!upstreamOrigins.has(url.origin)) return value
  return new URL(`${url.pathname}${url.search}`, fixtureOrigin).toString()
}

export class UpstreamError extends Error {
  readonly kind: "network" | "unauthorized" | "unavailable" | "invalid"

  constructor(kind: UpstreamError["kind"]) {
    super(kind)
    this.kind = kind
  }
}

export interface UpstreamOptions {
  fixtureOrigin?: string
  signal: AbortSignal
}

export async function fetchUpstreamJson(
  options: UpstreamOptions & { url: string; init?: RequestInit },
): Promise<unknown> {
  try {
    const response = await fetch(
      mapUpstreamUrl(options.url, options.fixtureOrigin),
      {
        ...options.init,
        redirect: "error",
        signal: AbortSignal.any([options.signal, AbortSignal.timeout(12_000)]),
      },
    )
    if (!response.ok) {
      await response.body?.cancel()
      throw new UpstreamError(
        response.status === 401 || response.status === 403 ?
          "unauthorized"
        : "unavailable",
      )
    }
    const text = await response.text()
    if (text.length > 4_000_000) throw new UpstreamError("invalid")
    return JSON.parse(text) as unknown
  } catch (error) {
    if (error instanceof UpstreamError) throw error
    options.signal.throwIfAborted()
    throw new UpstreamError("network")
  }
}

function parseUsageResponse(
  raw: unknown,
): NonNullable<DesktopSnapshot["usage"]> {
  const usage = upstreamUsageSchema.parse(raw)
  const quotas: NonNullable<DesktopSnapshot["usage"]>["quotas"] = []
  const labels: Record<string, string> = {
    chat: "Chat",
    completions: "Completions",
    premium_interactions: "Premium requests",
  }
  for (const [id, rawQuota] of Object.entries(usage.quota_snapshots)) {
    const parsed = quotaDetailSchema.safeParse(rawQuota)
    if (!parsed.success) continue
    const quota = parsed.data
    const label = labels[id] ?? id.replaceAll("_", " ")
    if (quota.unlimited) {
      quotas.push({ kind: "unlimited", id, label })
      continue
    }
    const remaining = quota.remaining ?? quota.quota_remaining
    const entitlement = quota.entitlement
    if (
      remaining === undefined
      || remaining === null
      || entitlement === undefined
      || entitlement === null
    )
      continue
    const limit = Math.max(0, entitlement)
    quotas.push({
      kind: "limited",
      id,
      label,
      remaining: Math.max(0, remaining),
      limit,
      percentRemaining: Math.max(
        0,
        Math.min(
          100,
          quota.percent_remaining
            ?? (limit > 0 ? (remaining / limit) * 100 : 0),
        ),
      ),
    })
  }
  return {
    plan: usage.copilot_plan,
    resetAt: usage.quota_reset_date ?? null,
    fetchedAt: new Date().toISOString(),
    quotas,
  }
}

export function createAccountClient(
  options: UpstreamOptions & {
    githubToken: string
    accountType: DesktopSettings["accountType"]
  },
) {
  const requestState = {
    githubToken: options.githubToken,
    accountType: options.accountType,
    vsCodeVersion: DEFAULT_VSCODE_VERSION,
    manualApprove: false,
    rateLimitWait: false,
    showToken: false,
    localApiKeys: [],
    responsesContextTrim: false,
  }
  const github = (path: string) =>
    fetchUpstreamJson({
      ...options,
      url: `https://api.github.com${path}`,
      init: { headers: githubHeaders(requestState) },
    })
  return {
    async user() {
      return z
        .object({
          login: z
            .string()
            .min(1)
            .max(80)
            .regex(/^[\w-]+$/),
          name: safeText.nullish().transform((name) => name ?? null),
        })
        .parse(await github("/user"))
    },
    async token() {
      return tokenSchema.parse(await github("/copilot_internal/v2/token"))
    },
    async models(copilotToken: string) {
      const base =
        options.accountType === "individual" ?
          "https://api.githubcopilot.com"
        : `https://api.${options.accountType}.githubcopilot.com`
      return upstreamCatalogSchema.parse(
        await fetchUpstreamJson({
          ...options,
          url: `${base}/models`,
          init: { headers: copilotHeaders({ ...requestState, copilotToken }) },
        }),
      )
    },
    async usage(): Promise<NonNullable<DesktopSnapshot["usage"]>> {
      return parseUsageResponse(await github("/copilot_internal/user"))
    },
  }
}

export function toDesktopModel(model: Model): DesktopModel {
  const supports: DesktopModel["supports"] = []
  if (model.capabilities.supports.tool_calls) supports.push("tools")
  if (model.capabilities.supports.vision) supports.push("vision")
  if (
    model.capabilities.supports.reasoning_effort?.length
    || model.capabilities.supports.adaptive_thinking
  )
    supports.push("reasoning")
  if (model.capabilities.supports.streaming) supports.push("streaming")
  return {
    id: model.id,
    name: model.name,
    vendor: model.vendor,
    type: model.capabilities.type,
    contextWindow: model.capabilities.limits.max_context_window_tokens ?? null,
    maxOutput: model.capabilities.limits.max_output_tokens ?? null,
    supports,
    endpoints: model.supported_endpoints ?? ["/chat/completions", "/responses"],
    preview: model.preview,
  }
}
