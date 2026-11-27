import consola from "consola"

import { sanitizeLogText } from "~/lib/client-info"
import { HTTPError } from "~/lib/error"

import {
  GeminiError,
  normalizeMimeType,
  SUPPORTED_INLINE_IMAGE_MIME_TYPES,
  type GenerateRequest,
  type Part,
} from "./schemas"

interface AttachmentFieldKeys {
  preferred: string
  fallback: string
}

interface MediaOmissionSummary {
  omittedCount: number
  unreadablePdfCount: number
  mimeTypes: Set<string>
}

const MAX_OMISSION_NOTES_PER_RESPONSE = 20

function normalizeStandardBase64(data: string): string {
  const compact = data.replaceAll(/[\r\n]+/g, "")
  if (compact.length === 0) return ""
  const replaced = compact.replaceAll("-", "+").replaceAll("_", "/")
  const remainder = replaced.length % 4
  if (remainder === 0) return replaced
  if (remainder === 1) return ""
  return replaced + "=".repeat(4 - remainder)
}

function decodedBase64Bytes(standardBase64: string): number {
  if (standardBase64.length === 0) return 0
  let padding = 0
  if (standardBase64.endsWith("==")) padding = 2
  else if (standardBase64.endsWith("=")) padding = 1
  return Math.max(0, Math.floor((standardBase64.length * 3) / 4) - padding)
}

function formatAttachmentBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function sanitizeDisplayName(
  displayName: string | undefined,
): string | undefined {
  const trimmed = displayName?.trim()
  if (!trimmed) return undefined
  const safe = sanitizeLogText(trimmed, 120)
    .replaceAll('"', "'")
    .replaceAll("[", "(")
    .replaceAll("]", ")")
    .trim()
  return safe || undefined
}

function formatAttachmentLabel(
  displayName: string | undefined,
  fallback: string,
): string {
  const safeName = sanitizeDisplayName(displayName)
  return safeName ? `Attachment "${safeName}"` : fallback
}

function formatOmittedAttachmentNote(
  displayName: string | undefined,
  normalizedMime: string,
  sizeLabel: string,
): string {
  const label = formatAttachmentLabel(displayName, "Attachment")
  const safeMime = sanitizeLogText(normalizedMime, 128)

  let guidance: string
  if (safeMime.startsWith("video/")) {
    guidance =
      "Inspect it with local tools such as ffprobe/ffmpeg or extract frames as PNG/JPEG images instead."
  } else if (safeMime.startsWith("audio/")) {
    guidance = "Inspect or transcribe it with local tools instead."
  } else if (safeMime.startsWith("image/")) {
    guidance = "Convert it to PNG, JPEG, or WebP to inspect it visually."
  } else {
    guidance = "Inspect it with local tools instead."
  }

  return `[${label} omitted: GitHub Copilot does not support inline ${safeMime} media (${sizeLabel}). ${guidance}]`
}

function formatFailedAttachmentNote(
  displayName: string | undefined,
  fallbackLabel: string,
  reason: string,
): string {
  const label = formatAttachmentLabel(displayName, fallbackLabel)
  return `[${label} omitted: ${sanitizeLogText(reason, 200)}]`
}

function appendResponseArrayField(
  response: Record<string, unknown>,
  keys: AttachmentFieldKeys,
  items: Array<string>,
): void {
  if (items.length === 0) return
  if (response[keys.preferred] === undefined) {
    response[keys.preferred] = [...items]
    return
  }
  if (Array.isArray(response[keys.preferred])) {
    response[keys.preferred] = [
      ...(response[keys.preferred] as Array<unknown>),
      ...items,
    ]
    return
  }
  if (response[keys.fallback] === undefined) {
    response[keys.fallback] = [...items]
    return
  }
  if (Array.isArray(response[keys.fallback])) {
    response[keys.fallback] = [
      ...(response[keys.fallback] as Array<unknown>),
      ...items,
    ]
    return
  }
  let suffix = 2
  while (`${keys.fallback}_${suffix}` in response) {
    suffix++
  }
  response[`${keys.fallback}_${suffix}`] = [...items]
}

function appendFunctionResponseAttachments(
  originalResponse: Record<string, unknown>,
  extractedDocuments: Array<string>,
  omittedAttachments: Array<string>,
): Record<string, unknown> {
  if (extractedDocuments.length === 0 && omittedAttachments.length === 0) {
    return originalResponse
  }
  const response = { ...originalResponse }
  if (response.output === undefined || typeof response.output === "string") {
    const combined = [...extractedDocuments, ...omittedAttachments]
    const existing = response.output
    response.output =
      existing ?
        `${existing}\n\n${combined.join("\n\n")}`
      : combined.join("\n\n")
    return response
  }

  appendResponseArrayField(
    response,
    { preferred: "extractedDocuments", fallback: "proxyExtractedDocuments" },
    extractedDocuments,
  )
  appendResponseArrayField(
    response,
    { preferred: "omittedAttachments", fallback: "proxyOmittedAttachments" },
    omittedAttachments,
  )
  return response
}

function isModelOnlyTurn(
  content: GenerateRequest["contents"][number],
): boolean {
  return (
    content.role === "model"
    && !content.parts.every((part) => "functionResponse" in part)
  )
}

function topLevelInlineNeedsPreprocessing(mimeType: string): boolean {
  const normalized = normalizeMimeType(mimeType)
  return normalized === "application/pdf" || normalized !== mimeType
}

function toolInlineNeedsPreprocessing(item: {
  mimeType: string
  data: string
}): boolean {
  const normalized = normalizeMimeType(item.mimeType)
  return (
    normalized !== item.mimeType
    || normalized === "application/pdf"
    || !SUPPORTED_INLINE_IMAGE_MIME_TYPES.has(normalized)
    || item.data.length === 0
    || item.data.length % 4 !== 0
    || /[\r\n_-]/.test(item.data)
  )
}

function needsMediaPreprocessing(request: GenerateRequest): boolean {
  return request.contents.some((content) => {
    const modelTurn = isModelOnlyTurn(content)
    return content.parts.some(
      (part) =>
        (!modelTurn
          && "inlineData" in part
          && topLevelInlineNeedsPreprocessing(part.inlineData.mimeType))
        || ("functionResponse" in part
          && part.functionResponse.parts?.some((item) =>
            toolInlineNeedsPreprocessing(item.inlineData),
          ) === true),
    )
  })
}

async function formatPdfText(inlineData: {
  data: string
  displayName?: string
}): Promise<string> {
  const { extractPdfText } = await import("~/lib/pdf")
  try {
    const extracted = await extractPdfText(
      normalizeStandardBase64(inlineData.data),
    )
    const safeName = sanitizeDisplayName(inlineData.displayName)
    const header = safeName ? `Document: ${safeName}\n\n` : ""
    const pages = `${extracted.pageCount} page${extracted.pageCount === 1 ? "" : "s"}`
    const suffix = extracted.truncated ? ", truncated" : ""
    return `${header}[Extracted text from PDF (${pages}${suffix}):]\n\n${extracted.text}`
  } catch (error) {
    if (error instanceof HTTPError) throw new GeminiError(error.message, 400)
    throw error
  }
}

interface FunctionResponsePartsAccumulator {
  remainingParts: NonNullable<
    Extract<Part, { functionResponse: unknown }>["functionResponse"]["parts"]
  >
  extractedDocuments: Array<string>
  omittedAttachments: Array<string>
  suppressedOmissions: number
  changed: boolean
  summary: MediaOmissionSummary
}

function recordOmission(
  acc: FunctionResponsePartsAccumulator,
  note: string,
  mimeType?: string,
): void {
  if (acc.omittedAttachments.length < MAX_OMISSION_NOTES_PER_RESPONSE) {
    acc.omittedAttachments.push(note)
  } else {
    acc.suppressedOmissions++
  }
  if (mimeType) {
    acc.summary.omittedCount++
    acc.summary.mimeTypes.add(mimeType)
  } else {
    acc.summary.unreadablePdfCount++
  }
}

async function processToolAttachmentItem(
  item: NonNullable<
    Extract<Part, { functionResponse: unknown }>["functionResponse"]["parts"]
  >[number],
  acc: FunctionResponsePartsAccumulator,
): Promise<void> {
  const normalizedMime = normalizeMimeType(item.inlineData.mimeType)
  const standardData = normalizeStandardBase64(item.inlineData.data)

  if (normalizedMime === "application/pdf") {
    acc.changed = true
    try {
      acc.extractedDocuments.push(
        await formatPdfText({ ...item.inlineData, data: standardData }),
      )
    } catch (error) {
      if (!(error instanceof GeminiError)) throw error
      recordOmission(
        acc,
        formatFailedAttachmentNote(
          item.inlineData.displayName,
          "PDF attachment",
          error.message,
        ),
      )
    }
    return
  }

  if (SUPPORTED_INLINE_IMAGE_MIME_TYPES.has(normalizedMime)) {
    if (standardData.length === 0) {
      acc.changed = true
      recordOmission(
        acc,
        formatFailedAttachmentNote(
          item.inlineData.displayName,
          "Image attachment",
          `empty ${normalizedMime} payload (0 B)`,
        ),
        normalizedMime,
      )
      return
    }
    if (
      normalizedMime !== item.inlineData.mimeType
      || standardData !== item.inlineData.data
    ) {
      acc.changed = true
      acc.remainingParts.push({
        inlineData: {
          ...item.inlineData,
          mimeType: normalizedMime,
          data: standardData,
        },
      })
    } else {
      acc.remainingParts.push(item)
    }
    return
  }

  acc.changed = true
  const sizeLabel = formatAttachmentBytes(decodedBase64Bytes(standardData))
  recordOmission(
    acc,
    formatOmittedAttachmentNote(
      item.inlineData.displayName,
      normalizedMime,
      sizeLabel,
    ),
    normalizedMime,
  )
}

async function preprocessFunctionResponsePart(
  part: Extract<Part, { functionResponse: unknown }>,
  summary: MediaOmissionSummary,
): Promise<Part> {
  const rawParts = part.functionResponse.parts
  if (!rawParts?.length) return part

  const acc: FunctionResponsePartsAccumulator = {
    remainingParts: [],
    extractedDocuments: [],
    omittedAttachments: [],
    suppressedOmissions: 0,
    changed: false,
    summary,
  }

  for (const item of rawParts) {
    await processToolAttachmentItem(item, acc)
  }

  if (acc.suppressedOmissions > 0) {
    acc.omittedAttachments.push(
      `[... and ${acc.suppressedOmissions} more unsupported/unreadable attachment(s) omitted]`,
    )
  }

  if (!acc.changed) return part

  return {
    functionResponse: {
      ...(part.functionResponse.id !== undefined ?
        { id: part.functionResponse.id }
      : {}),
      name: part.functionResponse.name,
      response: appendFunctionResponseAttachments(
        part.functionResponse.response,
        acc.extractedDocuments,
        acc.omittedAttachments,
      ),
      ...(acc.remainingParts.length > 0 ? { parts: acc.remainingParts } : {}),
    },
  }
}

async function preprocessPart(
  part: Part,
  modelTurn: boolean,
  summary: MediaOmissionSummary,
): Promise<Part> {
  if ("inlineData" in part) {
    if (modelTurn) return part
    const normalizedMime = normalizeMimeType(part.inlineData.mimeType)
    if (normalizedMime === "application/pdf") {
      return { text: await formatPdfText(part.inlineData) }
    }
    if (normalizedMime !== part.inlineData.mimeType) {
      return { inlineData: { ...part.inlineData, mimeType: normalizedMime } }
    }
    return part
  }
  if ("functionResponse" in part) {
    return preprocessFunctionResponsePart(part, summary)
  }
  return part
}

function logOmissionSummary(summary: MediaOmissionSummary): void {
  const details: Array<string> = []
  if (summary.omittedCount > 0) {
    const types = [...summary.mimeTypes]
      .slice(0, 5)
      .map((type) => sanitizeLogText(type, 64))
      .join(", ")
    details.push(
      `${summary.omittedCount} unsupported/empty (${types || "unknown"})`,
    )
  }
  if (summary.unreadablePdfCount > 0) {
    details.push(`${summary.unreadablePdfCount} unreadable PDF(s)`)
  }
  if (details.length > 0) {
    consola.warn(
      `Gemini tool media: omitted ${details.join(" and ")} attachment(s) from functionResponse.parts`,
    )
  }
}

export async function preprocessGeminiRequest(
  request: GenerateRequest,
): Promise<GenerateRequest> {
  if (!needsMediaPreprocessing(request)) return request
  const summary: MediaOmissionSummary = {
    omittedCount: 0,
    unreadablePdfCount: 0,
    mimeTypes: new Set(),
  }
  const contents = await Promise.all(
    request.contents.map(async (content) => {
      const modelTurn = isModelOnlyTurn(content)
      return {
        ...content,
        parts: await Promise.all(
          content.parts.map((part) => preprocessPart(part, modelTurn, summary)),
        ),
      }
    }),
  )
  logOmissionSummary(summary)
  return { ...request, contents }
}
