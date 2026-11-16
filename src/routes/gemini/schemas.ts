import { z } from "zod"

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
const responsePart = z.strictObject({
  functionResponse: z.strictObject({
    id: z.string().min(1).optional(),
    name: z.string().min(1),
    response: jsonObject,
  }),
})
const imagePart = z.strictObject({
  inlineData: z.strictObject({
    mimeType: z.enum([
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/heic",
      "image/heif",
    ]),
    data: z
      .string()
      .min(1)
      .regex(/^[A-Z0-9+/]+={0,2}$/i),
  }),
})
const partSchema = z.union([textPart, callPart, responsePart, imagePart])
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
          thinkingLevel: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
          includeThoughts: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
})
export type GenerateRequest = z.infer<typeof requestSchema>
const usageSchema = z.looseObject({
  prompt_tokens: z.number().nonnegative().optional(),
  completion_tokens: z.number().nonnegative().optional(),
  total_tokens: z.number().nonnegative().optional(),
  prompt_tokens_details: z
    .looseObject({ cached_tokens: z.number().nonnegative().optional() })
    .optional(),
})
const outputCall = z.looseObject({
  id: z.string(),
  type: z.literal("function").optional(),
  function: z.looseObject({ name: z.string(), arguments: z.string() }),
})
const messageSchema = z.looseObject({
  content: z.string().nullable().optional(),
  reasoning_text: z.string().nullable().optional(),
  reasoning_opaque: z.string().nullable().optional(),
  tool_calls: z.array(outputCall).optional(),
})
export const responseSchema = z.looseObject({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z
    .array(
      z.looseObject({
        index: z.number().int().nonnegative(),
        message: messageSchema,
        finish_reason: z.string().nullable(),
      }),
    )
    .max(1),
  usage: usageSchema.optional(),
})
export const chunkSchema = z.looseObject({
  id: z.string().optional(),
  model: z.string().optional(),
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
                id: z.string().optional(),
                function: z
                  .looseObject({
                    name: z.string().optional(),
                    arguments: z.string().optional(),
                  })
                  .optional(),
              }),
            )
            .optional(),
        }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .max(1),
  usage: usageSchema.optional(),
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
