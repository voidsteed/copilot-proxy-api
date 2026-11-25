import consola from "consola"

import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"

import { HTTPError } from "./error"
import { getModelPromptLimit } from "./model-limits"
import { state } from "./state"

export class PromptTooLongError extends HTTPError {
  readonly estimatedTokens: number
  readonly maxOutputTokens: number
  readonly modelLimit: number

  constructor(options: {
    estimatedTokens: number
    maxOutputTokens: number
    modelLimit: number
    response: Response
  }) {
    super("Prompt too long", options.response)
    this.estimatedTokens = options.estimatedTokens
    this.maxOutputTokens = options.maxOutputTokens
    this.modelLimit = options.modelLimit
  }
}

export function createPromptTooLongError(
  payload: ChatCompletionsPayload,
  bodyLength: number,
): PromptTooLongError {
  const estimatedTokens = Math.ceil(bodyLength / 4)
  const modelCaps = state.models?.data.find((m) => m.id === payload.model)
    ?.capabilities.limits
  const modelLimit = getModelPromptLimit(payload.model, modelCaps)
  const maxOutputTokens =
    payload.max_completion_tokens ?? payload.max_tokens ?? 0

  consola.warn(
    `Context overflow -> returning 400 prompt-too-long (~${estimatedTokens} + ${maxOutputTokens} > ${modelLimit}) to trigger Claude Code reactive compaction`,
  )

  return new PromptTooLongError({
    estimatedTokens,
    maxOutputTokens,
    modelLimit,
    response: new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: `prompt is too long: input length and \`max_tokens\` exceed context limit: ${estimatedTokens} + ${maxOutputTokens} > ${modelLimit} tokens`,
        },
      }),
      {
        status: 400,
        statusText: "Bad Request",
        headers: { "content-type": "application/json" },
      },
    ),
  })
}
