import consola from "consola"

import type {
  ChatCompletionsPayload,
  ContentPart,
  Message,
} from "~/services/copilot/create-chat-completions"
import type { Model } from "~/services/copilot/get-models"

import { getKnownModelPromptLimit } from "./model-limits"
import {
  type ConversationTurnGroup,
  HISTORY_OMITTED_USER_MESSAGE,
  IMAGE_LIMIT_PLACEHOLDER,
  IMAGE_STRIPPED_PLACEHOLDER,
  normalizeMessageParts,
  partitionTurnGroups,
  stripOrphanedArtifacts,
} from "./turn-groups"

export { TOOL_IMAGE_HEADER } from "./turn-groups"

// Copilot rejects payloads above 5 MiB (5,242,880 bytes); 5 MB leaves framing headroom.
export const MAX_PAYLOAD_BYTES = 5_000_000

// Unknown aliases stay below Copilot's 2.5-5.3 MB hang dead zone.
export const UNKNOWN_MODEL_PAYLOAD_BYTES = 1_900_000

const PRUNE_PROTECT_BYTES = 200_000
const PRUNE_MINIMUM_BYTES = 50_000
const TOOL_OUTPUT_HARD_CAP = 100_000
const CHARS_PER_TOKEN_ESTIMATE = 3.5
const TOKEN_RESERVE = 8_000

const PRUNED_PLACEHOLDER = "[content pruned — tool output was too old]"
const TOOL_TRUNCATED_SUFFIX = "\n\n[…tool output truncated to fit context]"

export interface PreparedWireRequest {
  payload: ChatCompletionsPayload
  body: string
  utf8Bytes: number
  enableVision: boolean
}

type FitPolicy =
  | { kind: "wire"; wireCeiling: number }
  | { kind: "dual"; estimatedCeiling: number; wireCeiling: number }

interface ImageLocation {
  msgIndex: number
  partIndex: number
}

interface ReductionResult {
  payload: ChatCompletionsPayload
  wireBytes: number
}

interface ReductionStage {
  label: string
  level: "info" | "warn"
  run: (current: ChatCompletionsPayload, wireBytes: number) => ReductionResult
}

function jsonUtf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8")
}

function measureWireBytes(payload: ChatCompletionsPayload): number {
  return jsonUtf8Bytes(payload)
}

function getEffectiveCeiling(policy: FitPolicy): number {
  return policy.kind === "dual" ?
      Math.min(policy.estimatedCeiling, policy.wireCeiling)
    : policy.wireCeiling
}

function decodedDataUrlBytes(url: string): number | undefined {
  const marker = ";base64,"
  const index = url.indexOf(marker)
  if (!url.startsWith("data:") || index === -1) return undefined
  const base64 = url.slice(index + marker.length)
  let padding = 0
  if (base64.endsWith("==")) padding = 2
  else if (base64.endsWith("=")) padding = 1
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
}

function stripOversizedImages(
  messages: Array<Message>,
  maxImageBytes: number,
): { messages: Array<Message>; stripped: number } {
  let stripped = 0
  const next = messages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg
    const before = stripped
    const content = msg.content.map((part) => {
      if (part.type !== "image_url") return part
      const size = decodedDataUrlBytes(part.image_url.url)
      if (size === undefined || size <= maxImageBytes) return part
      stripped++
      return {
        type: "text" as const,
        text: `[image omitted: exceeds Copilot's ${formatBytes(maxImageBytes)} image limit]`,
      }
    })
    return stripped > before ? normalizeMessageParts({ ...msg, content }) : msg
  })
  return { messages: next, stripped }
}

function stripExcessOldImages(
  messages: Array<Message>,
  maxImages: number,
): { messages: Array<Message>; stripped: number } {
  let totalImages = 0
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type === "image_url") totalImages++
    }
  }
  let toStrip = totalImages - maxImages
  if (toStrip <= 0) return { messages, stripped: 0 }

  let stripped = 0
  const next = messages.map((msg) => {
    if (toStrip <= 0 || !Array.isArray(msg.content)) return msg
    const before = stripped
    const content = msg.content.map((part) => {
      if (toStrip <= 0 || part.type !== "image_url") return part
      toStrip--
      stripped++
      return { type: "text" as const, text: IMAGE_LIMIT_PLACEHOLDER }
    })
    return stripped > before ? normalizeMessageParts({ ...msg, content }) : msg
  })
  return { messages: next, stripped }
}

function enforceVisionImageLimits(
  payload: ChatCompletionsPayload,
  model: Model,
): ChatCompletionsPayload {
  const vision = model.capabilities.limits.vision
  const maxImages = vision?.max_prompt_images
  const maxImageBytes = vision?.max_prompt_image_size
  const hasLimit =
    (maxImages !== undefined && maxImages > 0)
    || (maxImageBytes !== undefined && maxImageBytes > 0)
  if (!hasLimit || !hasVisionImages(payload)) return payload

  let messages = payload.messages
  let oversized = 0
  let excess = 0
  if (maxImageBytes !== undefined && maxImageBytes > 0) {
    const result = stripOversizedImages(messages, maxImageBytes)
    messages = result.messages
    oversized = result.stripped
  }
  if (maxImages !== undefined && maxImages > 0) {
    const result = stripExcessOldImages(messages, maxImages)
    messages = result.messages
    excess = result.stripped
  }
  if (oversized === 0 && excess === 0) return payload

  consola.warn(
    `Vision limits (${model.id}): omitted ${excess} oldest and ${oversized} oversized image(s) to stay within Copilot limits`,
  )
  return { ...payload, messages }
}

function hasVisionImages(payload: ChatCompletionsPayload): boolean {
  return payload.messages.some(
    (msg) =>
      Array.isArray(msg.content)
      && msg.content.some((part) => part.type === "image_url"),
  )
}

function computeTokenDerivedCeiling(model: Model): number | undefined {
  const maxPromptTokens = getKnownModelPromptLimit(
    model.id,
    model.capabilities.limits,
  )
  if (!maxPromptTokens) return undefined
  return Math.floor(
    (maxPromptTokens - TOKEN_RESERVE) * CHARS_PER_TOKEN_ESTIMATE,
  )
}

export function prepareChatCompletionsWireRequest(
  payload: ChatCompletionsPayload,
  model?: Model,
): PreparedWireRequest {
  const bounded = model ? enforceVisionImageLimits(payload, model) : payload
  const initialBody = JSON.stringify(bounded)
  const initialUtf8Bytes = Buffer.byteLength(initialBody, "utf8")

  if (initialUtf8Bytes <= MAX_PAYLOAD_BYTES) {
    return {
      payload: bounded,
      body: initialBody,
      utf8Bytes: initialUtf8Bytes,
      enableVision: hasVisionImages(bounded),
    }
  }

  const fitted = fitPayload(
    bounded,
    {
      kind: "wire",
      wireCeiling: MAX_PAYLOAD_BYTES,
    },
    initialUtf8Bytes,
  )
  const body = JSON.stringify(fitted)
  const utf8Bytes = Buffer.byteLength(body, "utf8")

  return {
    payload: fitted,
    body,
    utf8Bytes,
    enableVision: hasVisionImages(fitted),
  }
}

export function fitContext(
  payload: ChatCompletionsPayload,
  model: Model,
): ChatCompletionsPayload {
  const bounded = enforceVisionImageLimits(payload, model)
  const tokenCeiling = computeTokenDerivedCeiling(model)
  const policy: FitPolicy =
    tokenCeiling !== undefined && tokenCeiling < MAX_PAYLOAD_BYTES ?
      {
        kind: "dual",
        estimatedCeiling: tokenCeiling,
        wireCeiling: MAX_PAYLOAD_BYTES,
      }
    : { kind: "wire", wireCeiling: MAX_PAYLOAD_BYTES }
  return fitPayload(bounded, policy)
}

export function fitUnknownModelContext(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  return fitPayload(payload, {
    kind: "wire",
    wireCeiling: UNKNOWN_MODEL_PAYLOAD_BYTES,
  })
}

export function isPayloadOverUnknownModelCeiling(
  payload: ChatCompletionsPayload,
): boolean {
  return measureWireBytes(payload) > UNKNOWN_MODEL_PAYLOAD_BYTES
}

function runTransformStage(
  current: ChatCompletionsPayload,
  wireBytes: number,
  transform: (payload: ChatCompletionsPayload) => ChatCompletionsPayload,
): ReductionResult {
  const next = transform(current)
  if (next === current) return { payload: current, wireBytes }
  return { payload: next, wireBytes: measureWireBytes(next) }
}

function fitPayload(
  payload: ChatCompletionsPayload,
  policy: FitPolicy,
  knownWireBytes?: number,
): ChatCompletionsPayload {
  const initialBytes = knownWireBytes ?? measureWireBytes(payload)
  if (fitsPolicy(payload, policy, initialBytes)) return payload

  const effectiveCeiling = getEffectiveCeiling(policy)
  consola.info(
    `Context fit: payload ${formatBytes(initialBytes)} exceeds ${formatBytes(effectiveCeiling)} ceiling; reducing`,
  )

  const stripImagesStage: ReductionStage = {
    label: "stripping images",
    level: "info",
    run: (current, wireBytes) => stripImagesToFit(current, policy, wireBytes),
  }
  const pruneStage: ReductionStage = {
    label: "tool pruning",
    level: "info",
    run: (current, wireBytes) =>
      runTransformStage(current, wireBytes, pruneToolOutputs),
  }
  const truncateStage: ReductionStage = {
    label: "truncating oversized tool outputs",
    level: "warn",
    run: (current, wireBytes) =>
      runTransformStage(current, wireBytes, truncateOversizedToolOutputs),
  }

  const preDropStages =
    policy.kind === "wire" ?
      [stripImagesStage, pruneStage, truncateStage]
    : [pruneStage, stripImagesStage, truncateStage]

  let current = payload
  let wireBytes = initialBytes

  for (const stage of preDropStages) {
    const next = stage.run(current, wireBytes)
    if (next.payload === current) continue
    current = next.payload
    wireBytes = next.wireBytes
    if (fitsPolicy(current, policy, wireBytes)) {
      consola[stage.level](
        `Context fit: ${formatBytes(initialBytes)} -> ${formatBytes(wireBytes)} after ${stage.label}`,
      )
      return current
    }
  }

  const dropped = dropOldTurnGroups(current, policy, wireBytes)
  consola.warn(
    `Context fit: ${formatBytes(initialBytes)} -> ${formatBytes(dropped.wireBytes)} after dropping old turn groups`,
  )
  return dropped.payload
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b}B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`
  return `${(b / 1024 / 1024).toFixed(2)}MB`
}

function fitsPolicy(
  payload: ChatCompletionsPayload,
  policy: FitPolicy,
  knownWireBytes?: number,
): boolean {
  if (
    policy.kind === "dual"
    && estimatePayloadBytes(payload) > policy.estimatedCeiling
  ) {
    return false
  }
  return (knownWireBytes ?? measureWireBytes(payload)) <= policy.wireCeiling
}

function estimatePayloadBytes(payload: ChatCompletionsPayload): number {
  let bytes = 200
  for (const msg of payload.messages) {
    bytes += estimateMessageBytes(msg)
  }
  if (payload.tools) {
    for (const tool of payload.tools) {
      bytes += JSON.stringify(tool).length + 20
    }
  }
  return bytes
}

function estimateContentPartBytes(part: unknown): number {
  if (typeof part === "object" && part !== null && "type" in part) {
    if (
      part.type === "text"
      && "text" in part
      && typeof part.text === "string"
    ) {
      return part.text.length + 20
    }
    if (
      part.type === "image_url"
      && "image_url" in part
      && typeof part.image_url === "object"
      && part.image_url !== null
      && "url" in part.image_url
      && typeof part.image_url.url === "string"
    ) {
      return part.image_url.url.length + 40
    }
  }
  return JSON.stringify(part).length + 20
}

function estimateMessageBytes(msg: Message): number {
  let bytes = 40
  if (typeof msg.content === "string") {
    bytes += msg.content.length
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      bytes += estimateContentPartBytes(part)
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

function isJsonObjectString(content: string): boolean {
  const trimmed = content.trim()
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return (
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    )
  } catch {
    return false
  }
}

function pruneToolOutputs(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  const messages = payload.messages
  let protectedBytes = 0
  let prunedBytes = 0
  const prunedIndices: Array<number> = []

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== "tool") continue

    const msgBytes =
      typeof msg.content === "string" ?
        Buffer.byteLength(msg.content, "utf8") + 40
      : estimateMessageBytes(msg)
    if (protectedBytes < PRUNE_PROTECT_BYTES) {
      protectedBytes += msgBytes
    } else {
      prunedBytes += msgBytes
      prunedIndices.push(i)
    }
  }

  if (prunedBytes < PRUNE_MINIMUM_BYTES) return payload

  const newMessages = [...messages]
  for (const idx of prunedIndices) {
    const currentMsg = newMessages[idx]
    const replacement =
      (
        typeof currentMsg.content === "string"
        && isJsonObjectString(currentMsg.content)
      ) ?
        JSON.stringify({ output: PRUNED_PLACEHOLDER })
      : PRUNED_PLACEHOLDER
    newMessages[idx] = { ...currentMsg, content: replacement }
  }

  consola.info(
    `Pruned ${prunedIndices.length} old tool outputs (~${prunedBytes} bytes reclaimed)`,
  )
  return { ...payload, messages: newMessages }
}

function collectImageLocations(messages: Array<Message>): Array<ImageLocation> {
  const locations: Array<ImageLocation> = []
  for (const [msgIndex, msg] of messages.entries()) {
    if (!Array.isArray(msg.content)) continue
    for (const [partIndex, part] of msg.content.entries()) {
      if (part.type === "image_url") {
        locations.push({ msgIndex, partIndex })
      }
    }
  }
  return locations
}

function stripImagesToFit(
  payload: ChatCompletionsPayload,
  policy: FitPolicy,
  currentWireBytes: number,
): ReductionResult {
  const locations = collectImageLocations(payload.messages)
  if (locations.length === 0) {
    return { payload, wireBytes: currentWireBytes }
  }

  const messages = [...payload.messages]
  let wireBytes = currentWireBytes
  let strippedCount = 0
  let strippedBytes = 0

  for (const { msgIndex, partIndex } of locations) {
    const prevMsg = messages[msgIndex]
    if (!Array.isArray(prevMsg.content)) continue
    const part = prevMsg.content[partIndex]
    if (part.type !== "image_url") continue

    const nextContent: Array<ContentPart> = [...prevMsg.content]
    nextContent[partIndex] = {
      type: "text",
      text: IMAGE_STRIPPED_PLACEHOLDER,
    }
    const updatedMsg = normalizeMessageParts({
      ...prevMsg,
      content: nextContent,
    })
    wireBytes += jsonUtf8Bytes(updatedMsg) - jsonUtf8Bytes(prevMsg)
    strippedCount++
    strippedBytes += Buffer.byteLength(part.image_url.url, "utf8")
    messages[msgIndex] = updatedMsg

    const candidate = { ...payload, messages }
    if (fitsPolicy(candidate, policy, wireBytes)) {
      consola.info(
        `Stripped ${strippedCount} image(s) (~${strippedBytes} bytes reclaimed)`,
      )
      return { payload: candidate, wireBytes }
    }
  }

  if (strippedCount > 0) {
    consola.warn(
      `Stripped all ${strippedCount} image(s) (~${strippedBytes} bytes reclaimed)`,
    )
  }
  return { payload: { ...payload, messages }, wireBytes }
}

function utf8CodePointBytes(codePoint: number): number {
  if (codePoint <= 0x7f) return 1
  if (codePoint <= 0x7ff) return 2
  if (codePoint <= 0xffff) return 3
  return 4
}

function jsonEscapedCodePointBytes(codePoint: number): number {
  if (
    codePoint === 0x22
    || codePoint === 0x5c
    || codePoint === 0x08
    || codePoint === 0x0c
    || codePoint === 0x0a
    || codePoint === 0x0d
    || codePoint === 0x09
  ) {
    return 2
  }
  if (codePoint < 0x20 || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
    return 6
  }
  return utf8CodePointBytes(codePoint)
}

function truncateUtf8ByCost(
  text: string,
  maxBytes: number,
  byteCost: (codePoint: number) => number,
): string {
  if (maxBytes <= 0) return ""
  let bytes = 0
  let index = 0
  while (index < text.length) {
    const codePoint = text.codePointAt(index)
    if (codePoint === undefined) break
    const cost = byteCost(codePoint)
    if (bytes + cost > maxBytes) break
    bytes += cost
    index += codePoint > 0xffff ? 2 : 1
  }
  return text.slice(0, index)
}

function truncateToolContent(content: string): string {
  if (isJsonObjectString(content)) {
    const wrapperBytes = Buffer.byteLength(
      JSON.stringify({ truncated: true, output: TOOL_TRUNCATED_SUFFIX }),
      "utf8",
    )
    const prefix = truncateUtf8ByCost(
      content,
      Math.max(0, TOOL_OUTPUT_HARD_CAP - wrapperBytes),
      jsonEscapedCodePointBytes,
    )
    return JSON.stringify({
      truncated: true,
      output: prefix + TOOL_TRUNCATED_SUFFIX,
    })
  }

  const suffixBytes = Buffer.byteLength(TOOL_TRUNCATED_SUFFIX, "utf8")
  const prefix = truncateUtf8ByCost(
    content,
    Math.max(0, TOOL_OUTPUT_HARD_CAP - suffixBytes),
    utf8CodePointBytes,
  )
  return prefix + TOOL_TRUNCATED_SUFFIX
}

function truncateOversizedToolOutputs(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  let truncatedCount = 0
  let reclaimedBytes = 0
  const newMessages = payload.messages.map((msg) => {
    if (msg.role !== "tool" || typeof msg.content !== "string") return msg
    const beforeBytes = Buffer.byteLength(msg.content, "utf8")
    if (beforeBytes <= TOOL_OUTPUT_HARD_CAP) return msg
    const truncated = truncateToolContent(msg.content)
    truncatedCount++
    reclaimedBytes += beforeBytes - Buffer.byteLength(truncated, "utf8")
    return { ...msg, content: truncated }
  })
  if (truncatedCount === 0) return payload
  consola.warn(
    `Truncated ${truncatedCount} oversized tool outputs (~${reclaimedBytes} bytes reclaimed)`,
  )
  return { ...payload, messages: newMessages }
}

function hasHistoryMarker(
  groups: Array<ConversationTurnGroup>,
  droppedAny: boolean,
): boolean {
  return droppedAny && groups[0]?.messages[0]?.role === "assistant"
}

function buildCandidatePayload(options: {
  payload: ChatCompletionsPayload
  systemMessages: Array<Message>
  groups: Array<ConversationTurnGroup>
  droppedAny: boolean
}): ChatCompletionsPayload {
  const { payload, systemMessages, groups, droppedAny } = options
  const conversationMessages = groups.flatMap((group) => group.messages)
  const messages =
    droppedAny && conversationMessages[0]?.role === "assistant" ?
      [...systemMessages, HISTORY_OMITTED_USER_MESSAGE, ...conversationMessages]
    : [...systemMessages, ...conversationMessages]
  return { ...payload, messages }
}

function historyMarkerDelta(
  prevHasMarker: boolean,
  nextHasMarker: boolean,
  markerBytes: number,
): number {
  if (prevHasMarker === nextHasMarker) return 0
  return nextHasMarker ? markerBytes : -markerBytes
}

function tryVerifyCandidate(options: {
  payload: ChatCompletionsPayload
  systemMessages: Array<Message>
  groups: Array<ConversationTurnGroup>
  droppedAny: boolean
  policy: FitPolicy
  trackedWireBytes: number
}): { result?: ReductionResult; exactBytes?: number } {
  const {
    payload,
    systemMessages,
    groups,
    droppedAny,
    policy,
    trackedWireBytes,
  } = options
  if (trackedWireBytes > policy.wireCeiling) return {}
  const built = buildCandidatePayload({
    payload,
    systemMessages,
    groups,
    droppedAny,
  })
  if (!fitsPolicy(built, policy, trackedWireBytes)) return {}
  const exactBytes = measureWireBytes(built)
  if (!fitsPolicy(built, policy, exactBytes)) return { exactBytes }
  return { result: { payload: built, wireBytes: exactBytes } }
}

function dropOldTurnGroups(
  payload: ChatCompletionsPayload,
  policy: FitPolicy,
  currentWireBytes: number,
): ReductionResult {
  const systemMessages: Array<Message> = []
  const conversationMessages: Array<Message> = []
  for (const msg of payload.messages) {
    if (msg.role === "system" || msg.role === "developer") {
      systemMessages.push(msg)
    } else {
      conversationMessages.push(msg)
    }
  }

  const partitioned = partitionTurnGroups(conversationMessages)
  const { groups, orphansDropped } = stripOrphanedArtifacts(partitioned)
  const groupWireBytes = groups.map((group) =>
    group.messages.reduce((sum, m) => sum + jsonUtf8Bytes(m) + 1, 0),
  )
  const historyMarkerBytes = jsonUtf8Bytes(HISTORY_OMITTED_USER_MESSAGE) + 1

  let droppedAny = orphansDropped > 0
  let trackedWireBytes =
    droppedAny ?
      measureWireBytes(
        buildCandidatePayload({
          payload,
          systemMessages,
          groups,
          droppedAny: true,
        }),
      )
    : currentWireBytes
  let droppedGroups = 0
  let droppedMessages = 0
  let verified: ReductionResult | undefined

  while (groups.length > 1) {
    const check = tryVerifyCandidate({
      payload,
      systemMessages,
      groups,
      droppedAny,
      policy,
      trackedWireBytes,
    })
    if (check.result) {
      verified = check.result
      break
    }
    if (check.exactBytes !== undefined) trackedWireBytes = check.exactBytes

    const prevHasMarker = hasHistoryMarker(groups, droppedAny)
    const removed = groups.shift()
    const removedBytes = groupWireBytes.shift() ?? 0
    if (!removed) break

    trackedWireBytes -= removedBytes
    droppedGroups++
    droppedMessages += removed.messages.length
    droppedAny = true

    trackedWireBytes += historyMarkerDelta(
      prevHasMarker,
      hasHistoryMarker(groups, true),
      historyMarkerBytes,
    )
  }

  if (!verified) {
    const built = buildCandidatePayload({
      payload,
      systemMessages,
      groups,
      droppedAny,
    })
    verified = { payload: built, wireBytes: measureWireBytes(built) }
  }

  if (droppedAny) {
    consola.warn(
      `Dropped ${droppedGroups} oldest turn group(s) (${droppedMessages} messages) + ${orphansDropped} orphaned artifact(s)`,
    )
  }

  if (!fitsPolicy(verified.payload, policy, verified.wireBytes)) {
    consola.error(
      `Payload still over ${getEffectiveCeiling(policy)}B after all reductions (${verified.wireBytes}B); forwarding to upstream`,
    )
  }

  return verified
}
