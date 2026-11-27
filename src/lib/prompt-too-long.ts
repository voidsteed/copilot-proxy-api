import consola from "consola"

import { HTTPError } from "./error"
import { getModelPromptLimit } from "./model-limits"
import { state } from "./state"

export type PromptTooLongEnvelope = "anthropic" | "responses"
export type TokenCountSource = "estimated" | "upstream"

export interface CreatePromptTooLongInput {
  bodyBytes: number
  envelope?: PromptTooLongEnvelope
  maxOutputTokens: number
  model: string
  upstreamCounts?: { limit?: number; used?: number }
  upstreamErrorBody?: string
}

export interface UpstreamOverflowCheckInput {
  bodyBytes: number
  envelope?: PromptTooLongEnvelope
  errorBody: string
  maxOutputTokens: number
  model: string
  status: number
}

export class PromptTooLongError extends HTTPError {
  readonly estimatedTokens: number
  readonly maxOutputTokens: number
  readonly modelLimit: number
  readonly tokenCountSource: TokenCountSource

  constructor(options: {
    estimatedTokens: number
    maxOutputTokens: number
    modelLimit: number
    response: Response
    tokenCountSource: TokenCountSource
  }) {
    super("Prompt too long", options.response)
    this.estimatedTokens = options.estimatedTokens
    this.maxOutputTokens = options.maxOutputTokens
    this.modelLimit = options.modelLimit
    this.tokenCountSource = options.tokenCountSource
  }
}

const CONTEXT_OVERFLOW_PATTERNS = [
  /request entity too large/i,
  /exceeds the limit of \d+/i,
  /context_length_exceeded/i,
  /model_max_prompt_tokens_exceeded/i,
  /payload too large/i,
  /maximum context length/i,
  /prompt is too long/i,
  /input token count.*exceeds/i,
]

const TRANSIENT_OUTAGE_PATTERNS = [
  /service unavailable/i,
  /bad gateway/i,
  /gateway timeout/i,
  /temporarily unavailable/i,
  /upstream connect error/i,
  /overloaded/i,
  /try again later/i,
]

const UPSTREAM_PAIR_PATTERNS = [
  /prompt is too long:\D*(\d+)\s*tokens\s*>\s*(\d+)/i,
  /exceed context limit:\s*(\d+)\s*\+\s*\d+\s*>\s*(\d+)/i,
]

const UPSTREAM_USED_PATTERNS = [
  /input token count\s*\(?(\d+)\)?/i,
  /(?:resulted in|you requested|requested) (\d+) tokens/i,
  /prompt token count of (\d+)/i,
  /(\d+) prompt tokens/i,
]

const UPSTREAM_LIMIT_PATTERNS = [
  /maximum (?:number of )?tokens allowed\s*\(?(\d+)\)?/i,
  /maximum context length is (\d+) tokens/i,
  /exceeds the limit of (\d+)/i,
]

export const DEAD_ZONE_OVERFLOW_BYTES = 2_000_000

export function isExplicitContextOverflow(errorBody: string): boolean {
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(errorBody))
}

function isContextOverflowResponse(
  status: number,
  errorBody: string,
  bodyBytes: number,
): boolean {
  if (status === 413) return true
  if (isExplicitContextOverflow(errorBody)) return true
  if (status === 502 || status === 503 || status === 504) return false
  if (TRANSIENT_OUTAGE_PATTERNS.some((pattern) => pattern.test(errorBody))) {
    return false
  }

  // Copilot can hang on ~2.5-5.3 MB bodies and surface a plain 500 or timeout.
  return (
    (status === 500 || /operation timed out/i.test(errorBody))
    && bodyBytes > DEAD_ZONE_OVERFLOW_BYTES
  )
}

function parsePositiveSafeInteger(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function isPositiveSafeInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
}

function matchFirstInteger(
  errorBody: string,
  patterns: Array<RegExp>,
): number | undefined {
  for (const pattern of patterns) {
    const value = parsePositiveSafeInteger(pattern.exec(errorBody)?.[1])
    if (value !== undefined) return value
  }
  return undefined
}

function parseUpstreamTokenCounts(errorBody: string): {
  limit?: number
  used?: number
} {
  let used: number | undefined
  let limit: number | undefined

  for (const pattern of UPSTREAM_PAIR_PATTERNS) {
    const match = pattern.exec(errorBody)
    if (!match) continue
    used ??= parsePositiveSafeInteger(match[1])
    limit ??= parsePositiveSafeInteger(match[2])
  }

  used ??= matchFirstInteger(errorBody, UPSTREAM_USED_PATTERNS)
  limit ??= matchFirstInteger(errorBody, UPSTREAM_LIMIT_PATTERNS)

  return { limit, used }
}

export function createPromptTooLongError(
  input: CreatePromptTooLongInput,
): PromptTooLongError {
  const upstreamUsed =
    isPositiveSafeInteger(input.upstreamCounts?.used) ?
      input.upstreamCounts.used
    : undefined
  const upstreamLimit =
    isPositiveSafeInteger(input.upstreamCounts?.limit) ?
      input.upstreamCounts.limit
    : undefined

  const modelCaps = state.models?.data.find((m) => m.id === input.model)
    ?.capabilities.limits
  const modelLimit =
    upstreamLimit ?? getModelPromptLimit(input.model, modelCaps)
  const estimatedTokens =
    upstreamUsed ?? Math.max(Math.ceil(input.bodyBytes / 4), modelLimit + 1)
  const tokenCountSource: TokenCountSource =
    upstreamUsed !== undefined ? "upstream" : "estimated"
  const maxOutputTokens = input.maxOutputTokens
  const envelope = input.envelope ?? "anthropic"
  const message = `prompt is too long: input length and \`max_tokens\` exceed context limit: ${estimatedTokens} + ${maxOutputTokens} > ${modelLimit} tokens`
  const tokenPrefix = tokenCountSource === "estimated" ? "~" : ""

  consola.warn(
    `Context overflow -> returning 400 prompt-too-long (${tokenCountSource}: ${tokenPrefix}${estimatedTokens} + ${maxOutputTokens} > ${modelLimit})`,
  )

  const errorPayload =
    envelope === "responses" ?
      {
        type: "invalid_request_error",
        code: "context_length_exceeded",
        message,
        upstream_error: input.upstreamErrorBody?.slice(0, 2_000),
      }
    : {
        type: "invalid_request_error",
        message,
      }

  return new PromptTooLongError({
    estimatedTokens,
    maxOutputTokens,
    modelLimit,
    tokenCountSource,
    response: new Response(
      JSON.stringify({
        type: "error",
        error: errorPayload,
      }),
      {
        status: 400,
        statusText: "Bad Request",
        headers: { "content-type": "application/json" },
      },
    ),
  })
}

export function matchContextOverflowError(
  input: UpstreamOverflowCheckInput,
): PromptTooLongError | null {
  if (
    !isContextOverflowResponse(input.status, input.errorBody, input.bodyBytes)
  ) {
    return null
  }

  return createPromptTooLongError({
    model: input.model,
    maxOutputTokens: input.maxOutputTokens,
    bodyBytes: input.bodyBytes,
    upstreamCounts: parseUpstreamTokenCounts(input.errorBody),
    envelope: input.envelope,
    upstreamErrorBody: input.errorBody,
  })
}
