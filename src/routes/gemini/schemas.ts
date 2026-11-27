import { z } from "zod"

import { sanitizeLogText } from "~/lib/client-info"

const jsonObject = z.record(z.string(), z.unknown())
const signature = { thoughtSignature: z.string().optional() }
const textPart = z.strictObject({
  text: z.string(),
  thought: z.boolean().optional(),
  ...signature,
})
const callPart = z.strictObject({
  functionCall: z.strictObject({
    id: z.string().min(1).optional(),
    name: z.string().min(1),
    args: jsonObject.optional(),
  }),
  ...signature,
})
const SUPPORTED_INLINE_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
] as const

export const SUPPORTED_INLINE_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(
  SUPPORTED_INLINE_IMAGE_TYPES,
)

export const SUPPORTED_INLINE_MEDIA_DESCRIPTION = `${SUPPORTED_INLINE_IMAGE_TYPES.join(", ")}, and application/pdf`

export function normalizeMimeType(mimeType: string): string {
  const semicolon = mimeType.indexOf(";")
  const base = semicolon === -1 ? mimeType : mimeType.slice(0, semicolon)
  return base.trim().toLowerCase()
}

const MIME_TOKEN_REGEX =
  /^[a-z0-9][\w!#$&^.+-]{0,126}\/[a-z0-9][\w!#$&^.+-]{0,126}$/i
const DISALLOWED_MIME_CHARS = /[\p{Cc}\u2028\u2029]/u
const STANDARD_BASE64_REGEX = /^[a-z0-9+/]+={0,2}$/i
const URL_BASE64_REGEX = /^[\w-]+={0,2}$/

function isValidMimeType(value: string): boolean {
  if (value.length === 0 || value.length > 512) return false
  if (DISALLOWED_MIME_CHARS.test(value)) return false
  const semicolon = value.indexOf(";")
  const beforeSemi = semicolon === -1 ? value : value.slice(0, semicolon)
  const base = beforeSemi.replaceAll(/^[ \t]+|[ \t]+$/g, "")
  return MIME_TOKEN_REGEX.test(base)
}

function isValidBase64LengthAndPadding(compact: string): boolean {
  return compact.endsWith("=") ?
      compact.length % 4 === 0
    : compact.length % 4 !== 1
}

function isValidStandardBase64(value: string): boolean {
  return (
    STANDARD_BASE64_REGEX.test(value) && isValidBase64LengthAndPadding(value)
  )
}

function isValidFunctionResponseBase64(value: string): boolean {
  if (value.length === 0) return true
  const compact = value.replaceAll(/[\r\n]+/g, "")
  if (compact.length === 0) return false
  const matchesAlphabet =
    STANDARD_BASE64_REGEX.test(compact) || URL_BASE64_REGEX.test(compact)
  return matchesAlphabet && isValidBase64LengthAndPadding(compact)
}

const mimeTypeSchema = z
  .string()
  .max(512, "MIME type is too long")
  .refine(isValidMimeType, "Invalid MIME type")

const topLevelMimeTypeSchema = mimeTypeSchema.superRefine((value, ctx) => {
  const normalized = normalizeMimeType(value)
  if (
    normalized !== "application/pdf"
    && !SUPPORTED_INLINE_IMAGE_MIME_TYPES.has(normalized)
  ) {
    ctx.addIssue({
      code: "custom",
      message: `Unsupported inline media type "${sanitizeLogText(normalized, 128)}". GitHub Copilot supports ${SUPPORTED_INLINE_MEDIA_DESCRIPTION}.`,
    })
  }
})

const inlineDataPart = z.strictObject({
  inlineData: z.strictObject({
    mimeType: topLevelMimeTypeSchema,
    data: z
      .string()
      .min(1)
      .refine(isValidStandardBase64, "Invalid base64 data"),
    displayName: z.string().optional(),
  }),
})

const functionResponseInlineDataPart = z.strictObject({
  inlineData: z.strictObject({
    mimeType: mimeTypeSchema,
    data: z
      .string()
      .refine(isValidFunctionResponseBase64, "Invalid base64 data"),
    displayName: z.string().optional(),
  }),
})

const responsePart = z.strictObject({
  functionResponse: z.strictObject({
    id: z.string().min(1).optional(),
    name: z.string().min(1),
    response: jsonObject,
    parts: z.array(functionResponseInlineDataPart).optional(),
  }),
})
const partSchema = z.union([textPart, callPart, responsePart, inlineDataPart])
export type Part = z.infer<typeof partSchema>
const contentSchema = z.strictObject({
  role: z.enum(["user", "model"]).optional(),
  parts: z.array(partSchema).min(1),
})
const declaration = z
  .strictObject({
    name: z.string().min(1),
    description: z.string().optional(),
    parametersJsonSchema: jsonObject.optional(),
    parameters: jsonObject.optional(),
  })
  .refine(
    (value) => !value.parameters || !value.parametersJsonSchema,
    "Use only one parameter schema",
  )
export const requestSchema = z.strictObject({
  contents: z.array(contentSchema).min(1),
  systemInstruction: z
    .strictObject({
      role: z.enum(["user", "system"]).optional(),
      parts: z.array(z.strictObject({ text: z.string() })).min(1),
    })
    .optional(),
  tools: z
    .array(
      z.strictObject({ functionDeclarations: z.array(declaration).min(1) }),
    )
    .optional(),
  toolConfig: z
    .strictObject({
      functionCallingConfig: z.strictObject({
        mode: z.enum(["AUTO", "NONE", "ANY"]).optional(),
        allowedFunctionNames: z.array(z.string().min(1)).optional(),
      }),
    })
    .optional(),
  generationConfig: z
    .strictObject({
      temperature: z.number().min(0).max(2).optional(),
      topP: z.number().min(0).max(1).optional(),
      maxOutputTokens: z.number().int().positive().optional(),
      stopSequences: z.array(z.string()).max(4).optional(),
      candidateCount: z.literal(1).optional(),
      presencePenalty: z.number().min(-2).max(2).optional(),
      frequencyPenalty: z.number().min(-2).max(2).optional(),
      responseMimeType: z.enum(["text/plain", "application/json"]).optional(),
      thinkingConfig: z
        .strictObject({
          thinkingLevel: z
            .enum(["MINIMAL", "LOW", "MEDIUM", "HIGH", "XHIGH"])
            .optional(),
          thinkingBudget: z.literal(-1).optional(),
          includeThoughts: z.boolean().optional(),
        })
        .refine(
          (value) =>
            value.thinkingLevel === undefined
            || value.thinkingBudget === undefined,
          "Specify either thinkingLevel or thinkingBudget, not both",
        )
        .optional(),
    })
    .optional(),
})
export type GenerateRequest = z.infer<typeof requestSchema>
const usageSchema = z.looseObject({
  prompt_tokens: z.number().nonnegative().nullable().optional(),
  completion_tokens: z.number().nonnegative().nullable().optional(),
  total_tokens: z.number().nonnegative().nullable().optional(),
  prompt_tokens_details: z
    .looseObject({
      cached_tokens: z.number().nonnegative().nullable().optional(),
    })
    .nullable()
    .optional(),
  completion_tokens_details: z
    .looseObject({
      reasoning_tokens: z.number().nonnegative().nullable().optional(),
    })
    .nullable()
    .optional(),
})
const outputCall = z.looseObject({
  id: z.string(),
  type: z.literal("function").nullable().optional(),
  function: z.looseObject({ name: z.string(), arguments: z.string() }),
})
const messageSchema = z.looseObject({
  content: z.string().nullable().optional(),
  reasoning_text: z.string().nullable().optional(),
  reasoning_opaque: z.string().nullable().optional(),
  tool_calls: z.array(outputCall).nullable().optional(),
})
export const responseSchema = z.looseObject({
  id: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  choices: z
    .array(
      z.looseObject({
        index: z.number().int().nonnegative(),
        message: messageSchema,
        finish_reason: z.string().nullable(),
      }),
    )
    .max(1),
  usage: usageSchema.nullable().optional(),
})
export const chunkSchema = z.looseObject({
  id: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  choices: z
    .array(
      z.looseObject({
        index: z.number().int().nonnegative(),
        delta: z.looseObject({
          content: z.string().nullable().optional(),
          reasoning_text: z.string().nullable().optional(),
          reasoning_opaque: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.looseObject({
                index: z.number().int().nonnegative(),
                id: z.string().nullable().optional(),
                type: z.literal("function").nullable().optional(),
                function: z
                  .looseObject({
                    name: z.string().nullable().optional(),
                    arguments: z.string().nullable().optional(),
                  })
                  .nullable()
                  .optional(),
              }),
            )
            .nullable()
            .optional(),
        }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .max(1),
  usage: usageSchema.nullable().optional(),
})
export type UpstreamResponse = z.infer<typeof responseSchema>
export type UpstreamChunk = z.infer<typeof chunkSchema>
export const argumentsSchema = jsonObject

export class GeminiError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

type ValidationIssue = z.ZodError["issues"][number]

interface UnionBranchCandidate {
  missingRequiredKey: boolean
  unrecognizedKeyCount: number
  maxPathDepth: number
  primaryIssue: ValidationIssue
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function resolveValueAtPath(
  root: unknown,
  path: ReadonlyArray<PropertyKey>,
): unknown {
  let current: unknown = root
  for (const segment of path) {
    if (Array.isArray(current) && typeof segment === "number") {
      current = current[segment]
    } else if (
      isPlainRecord(current)
      && typeof segment === "string"
      && Object.hasOwn(current, segment)
    ) {
      current = current[segment]
    } else {
      return undefined
    }
  }
  return current
}

function isMissingRequiredTopKey(
  issue: ValidationIssue,
  valueAtUnion: unknown,
): boolean {
  if (issue.path.length === 0) return issue.code === "invalid_type"
  if (issue.path.length !== 1 || !isPlainRecord(valueAtUnion)) return false
  const key = issue.path[0]
  return (
    typeof key === "string"
    && (!Object.hasOwn(valueAtUnion, key) || valueAtUnion[key] === undefined)
  )
}

function scoreUnionBranch(
  branch: Array<ValidationIssue>,
  valueAtUnion: unknown,
): UnionBranchCandidate | undefined {
  if (branch.length === 0) return undefined
  let missingRequiredKey = !isPlainRecord(valueAtUnion)
  let unrecognizedKeyCount = 0
  let primaryIssue = branch[0]

  for (const issue of branch) {
    if (isMissingRequiredTopKey(issue, valueAtUnion)) {
      missingRequiredKey = true
    }
    if (issue.code === "unrecognized_keys" && issue.path.length === 0) {
      unrecognizedKeyCount += issue.keys.length
    }
    if (
      issue.path.length > primaryIssue.path.length
      || (issue.path.length === primaryIssue.path.length
        && primaryIssue.code === "unrecognized_keys"
        && issue.code !== "unrecognized_keys")
    ) {
      primaryIssue = issue
    }
  }

  return {
    missingRequiredKey,
    unrecognizedKeyCount,
    maxPathDepth: primaryIssue.path.length,
    primaryIssue,
  }
}

function compareBranchCandidates(
  a: UnionBranchCandidate,
  b: UnionBranchCandidate,
): number {
  if (a.missingRequiredKey !== b.missingRequiredKey) {
    return a.missingRequiredKey ? 1 : -1
  }
  if (a.unrecognizedKeyCount !== b.unrecognizedKeyCount) {
    return a.unrecognizedKeyCount - b.unrecognizedKeyCount
  }
  return b.maxPathDepth - a.maxPathDepth
}

function unwrapValidationIssue(
  issue: ValidationIssue,
  currentValue: unknown,
  depth = 0,
): { path: Array<PropertyKey>; message: string } {
  if (issue.code !== "invalid_union" || depth >= 4) {
    return { path: [...issue.path], message: issue.message }
  }

  const targetValue = resolveValueAtPath(currentValue, issue.path)
  const candidates = issue.errors
    .map((branch) => scoreUnionBranch(branch, targetValue))
    .filter((item): item is UnionBranchCandidate => item !== undefined)
    .sort(compareBranchCandidates)

  if (candidates.length === 0 || candidates[0].missingRequiredKey) {
    return { path: [...issue.path], message: issue.message }
  }
  if (
    candidates.length > 1
    && compareBranchCandidates(candidates[0], candidates[1]) === 0
  ) {
    return { path: [...issue.path], message: issue.message }
  }

  const inner = unwrapValidationIssue(
    candidates[0].primaryIssue,
    targetValue,
    depth + 1,
  )
  return {
    path: [...issue.path, ...inner.path],
    message: inner.message,
  }
}

export function formatZodValidationError(
  issues: Array<ValidationIssue>,
  input: unknown,
): {
  path: string
  message: string
} {
  if (issues.length === 0) return { path: "body", message: "Invalid input" }
  const resolved = unwrapValidationIssue(issues[0], input)
  const rawPath = resolved.path.map(String).join(".") || "body"
  return {
    path: sanitizeLogText(rawPath, 160) || "body",
    message: sanitizeLogText(resolved.message, 240) || "Invalid input",
  }
}
