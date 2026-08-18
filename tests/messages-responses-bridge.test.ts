import { afterEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ModelsResponse } from "~/services/copilot/get-models"

import { UNKNOWN_MODEL_PAYLOAD_BYTES } from "~/lib/context-manager"
import { forwardError } from "~/lib/error"
import { state } from "~/lib/state"
import { handleCompletion } from "~/routes/messages/handler"

state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

const notebookToolSchema = {
  type: "object",
  properties: {
    action: { type: "string" },
    notebookUri: { type: "string" },
  },
  required: ["action", "notebookUri"],
}

const anthropicNotebookTool = {
  name: "fabric_notebook_content",
  input_schema: notebookToolSchema,
}

const responsesNotebookTool = {
  type: "function",
  name: "fabric_notebook_content",
  strict: false,
  parameters: notebookToolSchema,
}

afterEach(() => {
  mock.restore()
  state.models = undefined
})

function createApp(): Hono {
  const app = new Hono()
  app.post("/v1/messages", async (c) => {
    try {
      return await handleCompletion(c)
    } catch (error) {
      return await forwardError(c, error)
    }
  })
  return app
}

function setModels(models: Array<{ endpoints?: Array<string>; id: string }>) {
  state.models = {
    object: "list",
    data: models.map(({ endpoints, id }) => ({
      id,
      object: "model",
      name: id,
      model_picker_enabled: true,
      preview: false,
      vendor: "openai",
      version: "1",
      supported_endpoints: endpoints,
      capabilities: {
        family: id,
        limits: {
          max_context_window_tokens: 400_000,
          max_output_tokens: 16_000,
          max_prompt_tokens: 272_000,
        },
        object: "model_capabilities",
        supports: {},
        tokenizer: "o200k_base",
        type: "chat",
      },
    })),
  } satisfies ModelsResponse
}

describe("Messages Responses bridge", () => {
  test("opens streaming SSE before Copilot returns response headers", async () => {
    setModels([{ id: "claude-opus-5", endpoints: ["/chat/completions"] }])
    const app = createApp()

    let resolveFetch: ((response: Response) => void) | undefined
    const upstreamResponse = new Promise<Response>((resolve) => {
      resolveFetch = resolve
    })
    const fetchMock = mock((url: string, options: RequestInit) => {
      expect(url).toBe("https://api.githubcopilot.com/chat/completions")
      expect(JSON.parse(options.body as string)).toMatchObject({
        model: "claude-opus-5",
      })
      return upstreamResponse
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const responsePromise = Promise.resolve(
      app.request("/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          model: "claude-opus-5",
          max_tokens: 100,
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
        headers: { "content-type": "application/json" },
      }),
    )

    type ResponseRaceResult =
      | { response: Response; type: "response" }
      | { type: "timeout" }

    const race = await Promise.race<ResponseRaceResult>([
      responsePromise.then(
        (response): ResponseRaceResult => ({ response, type: "response" }),
      ),
      new Promise<ResponseRaceResult>((resolve) => {
        setTimeout(() => resolve({ type: "timeout" }), 25)
      }),
    ])

    if (race.type === "timeout") {
      resolveFetch?.(
        new Response("data: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
      )
      await responsePromise.catch(() => {})
    }

    expect(race.type).toBe("response")
    if (race.type !== "response") return

    expect(race.response.status).toBe(200)
    const reader = race.response.body?.getReader()
    expect(reader).toBeDefined()
    if (!reader) return

    type ChunkRaceResult =
      | { result: Awaited<ReturnType<typeof reader.read>>; type: "chunk" }
      | { type: "timeout" }

    const firstChunk = await Promise.race<ChunkRaceResult>([
      reader
        .read()
        .then((result): ChunkRaceResult => ({ result, type: "chunk" })),
      new Promise<ChunkRaceResult>((resolve) => {
        setTimeout(() => resolve({ type: "timeout" }), 25)
      }),
    ])

    expect(firstChunk.type).toBe("chunk")
    if (firstChunk.type !== "chunk") return
    expect(firstChunk.result.done).toBe(false)
    if (firstChunk.result.done) return
    const chunkText = new TextDecoder().decode(
      firstChunk.result.value as Uint8Array,
    )
    expect(chunkText).toContain("event: ping")

    resolveFetch?.(
      new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      }),
    )
    await reader.cancel()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("emits prompt-too-long as a streaming Anthropic error", async () => {
    setModels([{ id: "claude-opus-4.8", endpoints: ["/chat/completions"] }])
    const app = createApp()
    const fetchMock = mock(
      () => new Response("request entity too large", { status: 413 }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await app.request("/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-opus-4.8",
        max_tokens: 100,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
      headers: { "content-type": "application/json" },
    })

    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain("event: error")
    expect(text).toContain("invalid_request_error")
    expect(text).toContain("prompt is too long")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe("Messages Responses bridge", () => {
  test("routes Responses-only models away from chat completions", async () => {
    setModels([{ id: "gpt-5.5", endpoints: ["/responses"] }])
    const app = createApp()
    const fetchMock = mock((url: string, opts: RequestInit) => {
      expect(url).toBe("https://api.githubcopilot.com/responses")
      expect(JSON.parse(opts.body as string)).toMatchObject({
        model: "gpt-5.5",
        input: [{ role: "user", content: "hello" }],
        max_output_tokens: 16,
        stream: false,
        tools: [responsesNotebookTool],
      })

      return new Response(
        JSON.stringify({
          id: "resp_123",
          object: "response",
          created_at: 0,
          model: "gpt-5.5",
          output: [
            {
              id: "msg_123",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "bridged" }],
            },
          ],
          output_text: "bridged",
          usage: {
            input_tokens: 10,
            output_tokens: 1,
            total_tokens: 11,
            input_tokens_details: { cached_tokens: 4 },
          },
          status: "completed",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await app.request("/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-5.5",
        max_tokens: 1,
        messages: [{ role: "user", content: "hello" }],
        tools: [anthropicNotebookTool],
      }),
      headers: { "content-type": "application/json" },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      type: "message",
      model: "gpt-5.5",
      content: [{ type: "text", text: "bridged" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 6,
        output_tokens: 1,
        cache_read_input_tokens: 4,
      },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("keeps chat-capable models on chat completions", async () => {
    setModels([{ id: "chat-model", endpoints: ["/chat/completions"] }])
    const app = createApp()
    const fetchMock = mock((url: string) => {
      expect(url).toBe("https://api.githubcopilot.com/chat/completions")
      return new Response(
        JSON.stringify({
          id: "chatcmpl_123",
          object: "chat.completion",
          created: 0,
          model: "chat-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "chat" },
              logprobs: null,
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await app.request("/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "chat-model",
        max_tokens: 100,
        messages: [{ role: "user", content: "hello" }],
      }),
      headers: { "content-type": "application/json" },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      content: [{ type: "text", text: "chat" }],
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("fits large custom Claude Code aliases before forwarding to Copilot", async () => {
    const app = createApp()
    const fetchMock = mock((_url: string, opts: RequestInit) => {
      const sentBody = opts.body as string
      const sentPayload = JSON.parse(sentBody) as {
        messages: Array<unknown>
        model: string
      }
      expect(sentBody.length).toBeLessThanOrEqual(UNKNOWN_MODEL_PAYLOAD_BYTES)
      expect(sentPayload.model).toBe("ultracode")
      expect(JSON.stringify(sentPayload.messages.at(-1))).toContain(
        "latest task",
      )

      return new Response(
        JSON.stringify({
          id: "chatcmpl_ultracode",
          object: "chat.completion",
          created: 0,
          model: "ultracode",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              logprobs: null,
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await app.request("/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "ultracode",
        max_tokens: 100,
        messages: [
          { role: "user", content: "old-1\n" + "x".repeat(900_000) },
          { role: "assistant", content: "old-2\n" + "x".repeat(900_000) },
          { role: "user", content: "old-3\n" + "x".repeat(900_000) },
          { role: "assistant", content: "old-4\n" + "x".repeat(900_000) },
          { role: "user", content: "latest task" },
        ],
      }),
      headers: { "content-type": "application/json" },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      content: [{ type: "text", text: "ok" }],
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("fails fast when a custom alias request cannot be fitted safely", async () => {
    const app = createApp()
    const fetchMock = mock(() => {
      throw new Error("fetch should not be called")
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await app.request("/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "ultracode",
        max_tokens: 100,
        messages: [{ role: "user", content: "x".repeat(2_500_000) }],
      }),
      headers: { "content-type": "application/json" },
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as {
      error: { type: string; message: string }
    }
    expect(body.error.type).toBe("invalid_request_error")
    expect(body.error.message).toContain("prompt is too long")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
