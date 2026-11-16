import { state } from "~/lib/state"
import { getModels, type Model } from "~/services/copilot/get-models"

import { GeminiError } from "./schemas"

function isGoogleChat(model: Model): boolean {
  return (
    model.vendor.toLowerCase() === "google"
    && model.capabilities.type === "chat"
    && model.supported_endpoints?.includes("/chat/completions") === true
  )
}
async function refreshModels() {
  const models = await getModels()
  state.models = models
  return models
}
export async function googleModels(refresh = false): Promise<Array<Model>> {
  const models = refresh || !state.models ? await refreshModels() : state.models
  return models.data.filter((model) => isGoogleChat(model))
}
export async function selectModel(id: string): Promise<Model> {
  let models = await googleModels()
  let model = models.find((item) => item.id === id)
  if (!model) {
    models = await googleModels(true)
    model = models.find((item) => item.id === id)
  }
  if (!model) throw new GeminiError("Google chat model not found", 404)
  return model
}
export function describeModel(model: Model) {
  return {
    name: `models/${model.id}`,
    version: model.version,
    displayName: model.name,
    inputTokenLimit: model.capabilities.limits.max_prompt_tokens,
    outputTokenLimit: model.capabilities.limits.max_output_tokens,
    supportedGenerationMethods:
      model.capabilities.supports.streaming ?
        ["generateContent", "streamGenerateContent"]
      : ["generateContent"],
  }
}
