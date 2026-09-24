/**
 * Context management for Copilot API payloads.
 *
 * Enforces TWO ceilings, whichever is smaller for a given model:
 *   1. Hard byte ceiling (~5 MB) — Copilot's Azure Front Door cliff
 *   2. Token-derived byte ceiling — model's max_prompt_tokens × 3.5 chars
 *
 * The token-derived ceiling prevents `model_max_prompt_tokens_exceeded`
 * rejections on models with stricter caps (e.g. opus-4.7 = 168K tokens),
 * which a 1 MB payload can easily breach.
 *
 * Fast path (~99% of Claude Code requests): byte size check → return.
 * Slow path: prune tool outputs → strip images → drop oldest messages →
 *           byte-based final backstop.
 */

import consola from "consola"

import type {
  ChatCompletionsPayload,
  Message,
} from "~/services/copilot/create-chat-completions"
import type { Model } from "~/services/copilot/get-models"

import { getKnownModelPromptLimit } from "./model-limits"

// ── Configuration ───────────────────────────────────────────────────────────

/**
 * Hard byte ceiling for Copilot. Empirically the cliff is at ~5.4 MB for
 * Azure Front Door; we set the proxy ceiling at 5,000,000 to leave ~400 KB
 * headroom for headers, tool definitions, and downstream JSON framing.
 *
 * Why 5 MB and not 2.5 MB (v0.9.1-v0.10.2 value):
 *   The 2.5 MB ceiling fired aggressively on normal Claude Code sessions
 *   (typical 6 MB → 0.9 MB prune per turn). The pruned payload causes
 *   Copilot to report a small prompt_tokens count, which Claude Code uses
 *   to compute its local context estimate via tokenCountWithEstimation.
 *   Because Claude Code's local message array still holds the full unpruned
 *   conversation, its local count climbs by the rough delta each turn until
 *   it hits the blocking limit (window - 3K) and Claude Code emits
 *   "Context limit reached" via the preempt path in query.ts:641 — without
 *   ever calling our proxy, so auto-compact never fires.
 *
 *   Raising the ceiling to 5 MB lets normal payloads pass through unmodified.
 *   Copilot then returns honest prompt_tokens, and Claude Code's auto-compact
 *   threshold (window - 13K) trips on schedule. Pruning still kicks in as a
 *   last-resort safety net for genuinely oversized payloads (≥5 MB), which
 *   is rare in normal Claude Code use.
 *
 *   This restores the v0.8.0 behavior (no proxy-side context manager) which
 *   the user reports worked reliably for auto-compact.
 */
const MAX_PAYLOAD_BYTES = 5_000_000

/** Conservative ceiling for custom Claude Code aliases / effort modes that do
 *  not appear in Copilot model metadata. Copilot can hang for minutes in the
 *  2.5-5 MB range, so unknown models stay below that dead zone. */
export const UNKNOWN_MODEL_PAYLOAD_BYTES = 1_900_000

/** Minimum protected byte budget for recent tool outputs before pruning. */
const PRUNE_PROTECT_BYTES = 200_000

/** Don't prune unless we'd reclaim at least this many bytes. */
const PRUNE_MINIMUM_BYTES = 50_000

/** Per-message hard cap for tool output content even when "recent". A single
 *  giant Read of a 1MB file shouldn't blow the budget by itself. */
const TOOL_OUTPUT_HARD_CAP = 100_000

/**
 * Empirical chars/token ratio for Claude Code payloads. Used to derive a
 * byte ceiling from the model's `max_prompt_tokens` without paying for a
 * real tokenizer pass. Real ratios on typical code-heavy Claude Code traffic
 * sit in the 3.0-3.8 range (English prose ~4.0, dense code ~3.0). We pick
 * 3.5 as a slightly conservative midpoint — it errs toward pruning a touch
 * earlier rather than letting Copilot reject. Cost: one multiplication per
 * request vs. ~300-1000ms for a real tokenizer pass on the hot path.
 */
const CHARS_PER_TOKEN_ESTIMATE = 3.5

/**
 * Reserve this many tokens under max_prompt_tokens for max_tokens output and
 * Copilot framing overhead (function-call encoding, message-wrapping tokens).
 * Copilot's reported prompt_token count typically runs a few thousand higher
 * than ours due to encoding differences; this buffer absorbs that skew.
 */
const TOKEN_RESERVE = 8_000

const PRUNED_PLACEHOLDER = "[content pruned — tool output was too old]"
const TOOL_TRUNCATED_SUFFIX = "\n\n[…tool output truncated to fit context]"
const IMAGE_STRIPPED_PLACEHOLDER = "[image removed to save context]"

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Compute the effective byte ceiling for a given model.
 *
 * The proxy enforces TWO ceilings and uses whichever is smaller:
 *
 *   1. The hard byte ceiling MAX_PAYLOAD_BYTES (~5 MB) — Copilot's Azure
 *      Front Door rejects payloads >5.4 MB regardless of token count.
 *
 *   2. A token-derived byte ceiling — Copilot ALSO rejects when the
 *      tokenized prompt exceeds the model's `max_prompt_tokens` cap, which
 *      varies per model (e.g. claude-opus-4.7 = 168K, others = 200K). A 1 MB
 *      payload on opus-4.7 can easily contain 169K tokens and get rejected
 *      with `model_max_prompt_tokens_exceeded`. To prevent that, we estimate
 *      a byte budget from the token cap using a fixed chars/token ratio.
 *
 * If `max_prompt_tokens` is missing from model metadata, we fall back to
 * MAX_PAYLOAD_BYTES alone (existing behavior, no regression).
 */
function computeEffectiveCeiling(model: Model): number {
  const maxPromptTokens = getKnownModelPromptLimit(
    model.id,
    model.capabilities.limits,
  )
  if (!maxPromptTokens) return MAX_PAYLOAD_BYTES
  const tokenDerivedBytes = Math.floor(
    (maxPromptTokens - TOKEN_RESERVE) * CHARS_PER_TOKEN_ESTIMATE,
  )
  return Math.min(MAX_PAYLOAD_BYTES, tokenDerivedBytes)
}

/**
 * Fit a payload within the model's effective byte ceiling. Returns the input
 * payload unmodified in the common case (cheap byte size check).
 */
export function fitContext(
  payload: ChatCompletionsPayload,
  model: Model,
): ChatCompletionsPayload {
  const ceiling = computeEffectiveCeiling(model)
  return fitPayloadToCeiling(payload, ceiling)
}

export function fitUnknownModelContext(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  return fitPayloadToCeiling(payload, UNKNOWN_MODEL_PAYLOAD_BYTES)
}

export function isPayloadOverUnknownModelCeiling(
  payload: ChatCompletionsPayload,
): boolean {
  return estimatePayloadBytes(payload) > UNKNOWN_MODEL_PAYLOAD_BYTES
}

function fitPayloadToCeiling(
  payload: ChatCompletionsPayload,
  ceiling: number,
): ChatCompletionsPayload {
  const initialBytes = estimatePayloadBytes(payload)

  // Fast path: well under the effective ceiling — just send.
  if (initialBytes <= ceiling) {
    return payload
  }

  consola.info(
    `Context fit: payload ${formatBytes(initialBytes)} exceeds ${formatBytes(ceiling)} ceiling — reducing`,
  )

  // Slow path: progressive byte-based reduction.
  let current = pruneToolOutputs(payload)
  let bytes = estimatePayloadBytes(current)
  if (bytes <= ceiling) {
    consola.info(
      `Context fit: ${formatBytes(initialBytes)} → ${formatBytes(bytes)} after tool pruning`,
    )
    return current
  }

  current = stripOldImages(current)
  bytes = estimatePayloadBytes(current)
  if (bytes <= ceiling) {
    consola.info(
      `Context fit: ${formatBytes(initialBytes)} → ${formatBytes(bytes)} after stripping old images`,
    )
    return current
  }

  // Aggressive: strip ALL images regardless of age.
  current = stripAllImages(current)
  bytes = estimatePayloadBytes(current)
  if (bytes <= ceiling) {
    consola.warn(
      `Context fit: ${formatBytes(initialBytes)} → ${formatBytes(bytes)} after stripping ALL images`,
    )
    return current
  }

  // Truncate any oversized tool outputs that survived pruning (e.g. recent ones).
  current = truncateOversizedToolOutputs(current)
  bytes = estimatePayloadBytes(current)
  if (bytes <= ceiling) {
    consola.warn(
      `Context fit: ${formatBytes(initialBytes)} → ${formatBytes(bytes)} after truncating oversized tool outputs`,
    )
    return current
  }

  current = dropOldMessages(current, ceiling)
  bytes = estimatePayloadBytes(current)
  consola.warn(
    `Context fit: ${formatBytes(initialBytes)} → ${formatBytes(bytes)} after dropping old messages`,
  )
  return current
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b}B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`
  return `${(b / 1024 / 1024).toFixed(2)}MB`
}

// ── Byte estimation ─────────────────────────────────────────────────────────

/**
 * Cheap byte-size estimate for a payload. Uses content lengths directly
 * instead of JSON.stringify, which is ~10x faster on large payloads. The
 * estimate is a lower bound (ignores JSON framing overhead) but accurate
 * to within a few percent for realistic Claude Code payloads.
 */
function estimatePayloadBytes(payload: ChatCompletionsPayload): number {
  let bytes = 200 // baseline for top-level JSON framing
  for (const msg of payload.messages) {
    bytes += estimateMessageBytes(msg)
  }
  if (payload.tools) {
    for (const tool of payload.tools) {
      // Tool definitions are dense JSON; conservatively double-count via stringify.
      bytes += JSON.stringify(tool).length + 20
    }
  }
  return bytes
}

function estimateMessageBytes(msg: Message): number {
  let bytes = 40 // role + framing
  if (typeof msg.content === "string") {
    bytes += msg.content.length
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if ("text" in part && typeof part.text === "string") {
        bytes += part.text.length + 20
      } else if ("type" in part && part.type === "image_url") {
        bytes += part.image_url.url.length + 40
      }
    }
  }
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      bytes += tc.function.name.length + tc.function.arguments.length + 80
    }
  }
  if (msg.tool_call_id) bytes += msg.tool_call_id.length + 20
  if (msg.reasoning_text) bytes += msg.reasoning_text.length + 20
  if (msg.reasoning_opaque) bytes += msg.reasoning_opaque.length + 20
  return bytes
}

// ── Reduction step 1: prune old tool outputs ────────────────────────────────

function pruneToolOutputs(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  const messages = payload.messages
  let protectedBytes = 0
  let prunedBytes = 0
  const prunedIndices: Array<number> = []

  // Walk newest → oldest, protecting recent tool outputs.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== "tool") continue

    const msgBytes = estimateMessageBytes(msg)
    if (protectedBytes < PRUNE_PROTECT_BYTES) {
      protectedBytes += msgBytes
    } else {
      prunedBytes += msgBytes
      prunedIndices.push(i)
    }
  }

  if (prunedBytes < PRUNE_MINIMUM_BYTES) {
    return payload
  }

  const newMessages = [...messages]
  for (const idx of prunedIndices) {
    newMessages[idx] = { ...newMessages[idx], content: PRUNED_PLACEHOLDER }
  }

  consola.info(
    `Pruned ${prunedIndices.length} old tool outputs (~${prunedBytes} bytes reclaimed)`,
  )
  return { ...payload, messages: newMessages }
}

// ── Reduction step 2: strip base64 images from older messages ───────────────

function stripOldImages(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  const messages = payload.messages
  const newMessages = [...messages]
  let strippedCount = 0
  let strippedBytes = 0

  // Keep images only in the last 4 messages (recent visual context).
  const protectFromEnd = 4
  const protectBoundary = Math.max(0, messages.length - protectFromEnd)

  for (let i = 0; i < protectBoundary; i++) {
    const msg = messages[i]
    if (!Array.isArray(msg.content)) continue

    const beforeStripped = strippedCount
    const newContent = msg.content.map((part) => {
      if ("type" in part && part.type === "image_url") {
        strippedCount++
        strippedBytes += part.image_url.url.length
        return { type: "text" as const, text: IMAGE_STRIPPED_PLACEHOLDER }
      }
      return part
    })

    if (strippedCount > beforeStripped) {
      newMessages[i] = { ...msg, content: newContent }
    }
  }

  if (strippedCount > 0) {
    consola.info(
      `Stripped ${strippedCount} base64 images (~${strippedBytes} bytes reclaimed)`,
    )
  }
  return { ...payload, messages: newMessages }
}

// ── Reduction step 2b: strip ALL images regardless of recency ───────────────

function stripAllImages(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  let strippedCount = 0
  let strippedBytes = 0
  const newMessages = payload.messages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg
    const before = strippedCount
    const newContent = msg.content.map((part) => {
      if ("type" in part && part.type === "image_url") {
        strippedCount++
        strippedBytes += part.image_url.url.length
        return { type: "text" as const, text: IMAGE_STRIPPED_PLACEHOLDER }
      }
      return part
    })
    return strippedCount > before ? { ...msg, content: newContent } : msg
  })
  if (strippedCount > 0) {
    consola.warn(
      `Stripped ${strippedCount} ALL images (~${strippedBytes} bytes reclaimed)`,
    )
  }
  return { ...payload, messages: newMessages }
}

// ── Reduction step 2c: truncate oversized tool outputs ──────────────────────

function truncateOversizedToolOutputs(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  let truncatedCount = 0
  let reclaimedBytes = 0
  const newMessages = payload.messages.map((msg) => {
    if (msg.role !== "tool") return msg
    if (typeof msg.content !== "string") return msg
    if (msg.content.length <= TOOL_OUTPUT_HARD_CAP) return msg
    const before = msg.content.length
    const truncated =
      msg.content.slice(0, TOOL_OUTPUT_HARD_CAP) + TOOL_TRUNCATED_SUFFIX
    truncatedCount++
    reclaimedBytes += before - truncated.length
    return { ...msg, content: truncated }
  })
  if (truncatedCount > 0) {
    consola.warn(
      `Truncated ${truncatedCount} oversized tool outputs (~${reclaimedBytes} bytes reclaimed)`,
    )
  }
  return { ...payload, messages: newMessages }
}

// ── Reduction step 3: drop oldest conversation messages ─────────────────────

function dropOldMessages(
  payload: ChatCompletionsPayload,
  ceiling: number,
): ChatCompletionsPayload {
  const systemMessages = payload.messages.filter(
    (m) => m.role === "system" || m.role === "developer",
  )
  const conversationMessages = payload.messages.filter(
    (m) => m.role !== "system" && m.role !== "developer",
  )

  // Compute reusable system byte total.
  let baseBytes = 200
  for (const m of systemMessages) baseBytes += estimateMessageBytes(m)
  if (payload.tools) {
    for (const tool of payload.tools) {
      baseBytes += JSON.stringify(tool).length + 20
    }
  }

  // Compute per-message byte sizes once for the conversation tail.
  const convBytes = conversationMessages.map((m) => estimateMessageBytes(m))
  let totalBytes = baseBytes + convBytes.reduce((a, b) => a + b, 0)

  let dropped = 0
  while (conversationMessages.length > 2 && totalBytes > ceiling) {
    const removedBytes = convBytes.shift() ?? 0
    conversationMessages.shift()
    totalBytes -= removedBytes
    dropped++
  }

  // Avoid stranding a tool_result whose corresponding tool_use was just
  // dropped. Copilot/Vertex rejects with "unexpected tool_use_id ... Each
  // tool_result block must have a corresponding tool_use block in the
  // previous message." Keep dropping from the front while the new head is
  // either a `tool` role message OR a user/assistant message whose content
  // begins with a tool_result/tool_use_id reference. Cheapest heuristic:
  // drop while head.role === "tool".
  let orphansDropped = 0
  while (
    conversationMessages.length > 2
    && conversationMessages[0].role === "tool"
  ) {
    const removedBytes = convBytes.shift() ?? 0
    conversationMessages.shift()
    totalBytes -= removedBytes
    orphansDropped++
  }

  if (dropped > 0 || orphansDropped > 0) {
    consola.warn(
      `Dropped ${dropped} oldest conversation messages + ${orphansDropped} orphaned tool results (~${totalBytes} bytes remaining, limit ${ceiling})`,
    )
  }

  if (totalBytes > ceiling) {
    consola.error(
      `Payload still over ${ceiling}B after all reductions (${totalBytes}B). Forwarding anyway — Copilot will likely return 413 → 400 prompt-too-long for reactive compaction.`,
    )
  }

  return {
    ...payload,
    messages: [...systemMessages, ...conversationMessages],
  }
}
