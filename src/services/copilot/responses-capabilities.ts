import type { ResponsesApiRequest } from "~/routes/responses/types"

import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

const GPT6_RESPONSES_MODELS = new Set([
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6.2-sol",
])

export function sanitizeGpt6Payload(
  payload: ResponsesApiRequest,
): ResponsesApiRequest {
  if (!GPT6_RESPONSES_MODELS.has(payload.model)) return payload
  const sanitized = { ...payload }
  delete sanitized.temperature
  delete sanitized.top_p
  delete sanitized.top_logprobs
  delete sanitized.logprobs
  if (sanitized.include?.includes("message.output_text.logprobs")) {
    sanitized.include = sanitized.include.filter(
      (item) => item !== "message.output_text.logprobs",
    )
  }
  return sanitized
}

export function validateResponsesCapabilities(
  payload: ResponsesApiRequest,
): void {
  const efforts = state.models?.data.find((model) => model.id === payload.model)
    ?.capabilities.supports.reasoning_effort
  if (
    payload.reasoning?.effort
    && efforts?.length
    && !efforts.includes(payload.reasoning.effort)
  ) {
    throw new HTTPError(
      "Unsupported reasoning effort",
      Response.json(
        {
          error: {
            type: "invalid_request_error",
            code: "unsupported_parameter",
            param: "reasoning.effort",
            message: `Model ${payload.model} supports reasoning effort: ${efforts.join(", ")}`,
          },
        },
        { status: 400 },
      ),
    )
  }
}
