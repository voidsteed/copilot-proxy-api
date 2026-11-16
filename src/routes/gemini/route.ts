import type { Context } from "hono"

import { Hono } from "hono"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { HTTPError } from "~/lib/error"
import { checkRateLimit } from "~/lib/rate-limit"
import { setRequestLogMetadata } from "~/lib/request-log"
import { state } from "~/lib/state"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"

import { describeModel, googleModels, selectModel } from "./models"
import { GeminiError, requestSchema, responseSchema } from "./schemas"
import { GeminiStream } from "./stream"
import { translateRequest, translateResponse } from "./translation"

export const geminiRoutes = new Hono()
const statuses = new Map([
  [400, "INVALID_ARGUMENT"],
  [401, "UNAUTHENTICATED"],
  [403, "PERMISSION_DENIED"],
  [404, "NOT_FOUND"],
  [408, "DEADLINE_EXCEEDED"],
  [413, "INVALID_ARGUMENT"],
  [429, "RESOURCE_EXHAUSTED"],
  [499, "CANCELLED"],
  [500, "INTERNAL"],
  [502, "UNAVAILABLE"],
  [503, "UNAVAILABLE"],
  [504, "DEADLINE_EXCEEDED"],
])
function errorBody(error: unknown) {
  let code = 502
  if (error instanceof GeminiError) code = error.status
  else if (error instanceof HTTPError) code = error.response.status
  else if (error instanceof Error && error.name === "AbortError") code = 499
  const messages = new Map([
    [429, "Rate limit exceeded"],
    [403, "Request not permitted"],
    [499, "Request cancelled"],
  ])
  const message =
    error instanceof GeminiError ?
      error.message
    : (messages.get(code) ?? "Upstream request failed")
  return { error: { code, status: statuses.get(code) ?? "UNKNOWN", message } }
}
function errorResponse(error: unknown) {
  const body = errorBody(error)
  return Response.json(body, { status: body.error.code })
}

geminiRoutes.get("/", async () => {
  try {
    return Response.json({
      models: (await googleModels(true)).map((model) => describeModel(model)),
    })
  } catch (error) {
    return errorResponse(error)
  }
})
geminiRoutes.get("/:model", async (c) => {
  try {
    return Response.json(describeModel(await selectModel(c.req.param("model"))))
  } catch (error) {
    return errorResponse(error)
  }
})
function generationAddress(c: Context) {
  const path = c.req.param("model") ?? ""
  const separator = path.lastIndexOf(":")
  const modelId = path.slice(0, separator)
  const method = path.slice(separator + 1)
  if (
    separator < 1
    || !["generateContent", "streamGenerateContent"].includes(method)
  )
    throw new GeminiError("Unsupported generation method", 404)
  const streaming = method === "streamGenerateContent"
  if (streaming && c.req.query("alt") !== "sse")
    throw new GeminiError("streamGenerateContent requires alt=sse")
  return { modelId, streaming }
}
async function readRequest(c: Context) {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    throw new GeminiError("Request body must be valid JSON")
  }
  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new GeminiError(
      `Unsupported or invalid Gemini request field at ${issue.path.join(".") || "body"}. ${issue.message}`,
    )
  }
  return parsed.data
}
async function generate(c: Context) {
  const { modelId, streaming } = generationAddress(c)
  const request = await readRequest(c)
  const model = await selectModel(modelId)
  const payload = translateRequest(request, model, streaming)
  setRequestLogMetadata(c, {
    model: model.id,
    effort: payload.reasoning_effort,
  })
  await checkRateLimit(state)
  if (state.manualApprove) await awaitApproval()
  const controller = new AbortController()
  const abort = () => controller.abort()
  c.req.raw.signal.addEventListener("abort", abort, { once: true })
  if (c.req.raw.signal.aborted) abort()
  let response: Awaited<ReturnType<typeof createChatCompletions>>
  try {
    response = await createChatCompletions(payload, controller.signal)
  } catch (error) {
    c.req.raw.signal.removeEventListener("abort", abort)
    throw error
  }
  const includeThoughts =
    request.generationConfig?.thinkingConfig?.includeThoughts === true
  if ("choices" in response) {
    c.req.raw.signal.removeEventListener("abort", abort)
    const parsedResponse = responseSchema.safeParse(response)
    if (!parsedResponse.success)
      throw new GeminiError("Invalid upstream response", 502)
    if (streaming)
      throw new GeminiError("Upstream did not return a stream", 502)
    return c.json(translateResponse(parsedResponse.data, includeThoughts))
  }
  if (!streaming) {
    controller.abort()
    c.req.raw.signal.removeEventListener("abort", abort)
    throw new GeminiError("Upstream returned an unexpected stream", 502)
  }
  const translated = new GeminiStream(includeThoughts)
  return streamSSE(c, async (stream) => {
    stream.onAbort(abort)
    try {
      for await (const event of response) {
        if (controller.signal.aborted) break
        if (!event.data) continue
        if (event.data === "[DONE]") break
        for (const output of translated.push(event.data))
          await stream.writeSSE({ data: JSON.stringify(output) })
      }
      if (!controller.signal.aborted)
        for (const output of translated.complete())
          await stream.writeSSE({ data: JSON.stringify(output) })
    } catch (error) {
      if (!controller.signal.aborted)
        await stream.writeSSE({ data: JSON.stringify(errorBody(error)) })
    } finally {
      controller.abort()
      c.req.raw.signal.removeEventListener("abort", abort)
    }
  })
}
geminiRoutes.post("/:model", async (c) => {
  try {
    return await generate(c)
  } catch (error) {
    return errorResponse(error)
  }
})
