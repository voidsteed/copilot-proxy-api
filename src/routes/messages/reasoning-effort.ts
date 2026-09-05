import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"

import { state } from "~/lib/state"

export function translateReasoningEffort(
  model: string,
  effort: ChatCompletionsPayload["reasoning_effort"],
): ChatCompletionsPayload["reasoning_effort"] {
  if (!effort) return undefined

  const modelMetadata = state.models?.data.find((m) => m.id === model)
  if (!modelMetadata) return effort

  const supportedEfforts = modelMetadata.capabilities.supports.reasoning_effort
  if (!supportedEfforts?.length) return undefined

  return supportedEfforts.includes(effort) ? effort : undefined
}
