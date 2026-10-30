import type { IncomingMessage, ServerResponse } from "node:http"

import { createServer } from "node:http"
import { z } from "zod"

import type {
  Model,
  ModelsResponse,
} from "../../src/services/copilot/get-models"

export type FixtureOAuthMode =
  | "approved"
  | "pending"
  | "denied"
  | "expired"
  | "slow"

export interface FixtureUpstream {
  origin: string
  close(): Promise<void>
  setOAuthMode(mode: FixtureOAuthMode): void
  readonly metrics: {
    readonly requests: number
    readonly abortedStreams: number
    readonly completedStreams: number
  }
}

const githubToken = "fixture_github_token"
const copilotToken = "fixture_copilot_token"
const bodyLimit = 1024 * 1024
const usage = {
  prompt_tokens: 37,
  completion_tokens: 9,
  total_tokens: 46,
  prompt_tokens_details: { cached_tokens: 5 },
}
const responseUsage = {
  input_tokens: 37,
  output_tokens: 9,
  total_tokens: 46,
  input_tokens_details: { cached_tokens: 5 },
  output_tokens_details: { reasoning_tokens: 0 },
}

const textPartSchema = z
  .object({ type: z.string(), text: z.string().optional() })
  .loose()
const contentSchema = z.union([z.string(), z.array(textPartSchema), z.null()])
const messageSchema = z
  .object({
    role: z.enum(["user", "assistant", "system", "tool", "developer"]),
    content: contentSchema.optional(),
  })
  .loose()
const chatSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(messageSchema).min(1),
    stream: z.boolean().nullable().optional(),
  })
  .loose()
const responsesSchema = z
  .object({
    model: z.string().min(1),
    input: z.union([
      z.string(),
      z.array(
        z
          .object({
            type: z.string().optional(),
            role: z.string().optional(),
            content: contentSchema.optional(),
            output: contentSchema.optional(),
          })
          .loose(),
      ),
    ]),
    stream: z.boolean().optional(),
  })
  .loose()
const generationSchema = z.discriminatedUnion("endpoint", [
  z.object({ endpoint: z.literal("/chat/completions"), body: chatSchema }),
  z.object({ endpoint: z.literal("/responses"), body: responsesSchema }),
])
const deviceRequestSchema = z.object({ client_id: z.string().min(1) }).loose()
const tokenRequestSchema = z.object({ device_code: z.string().min(1) }).loose()

function fixtureModel(
  id: string,
  name: string,
  options: {
    vendor: string
    context: number
    output: number
    tools: boolean
    vision: boolean
    reasoning?: boolean
    preview?: boolean
    endpoints?: Array<string>
  },
): Model {
  return {
    id,
    name: `${name} (local fixture)`,
    vendor: options.vendor,
    object: "model",
    version: "fixture-1",
    model_picker_enabled: true,
    preview: options.preview ?? false,
    supported_endpoints: options.endpoints ?? [
      "/chat/completions",
      "/responses",
    ],
    capabilities: {
      object: "model_capabilities",
      family: id,
      type: "chat",
      tokenizer: "o200k_base",
      limits: {
        max_context_window_tokens: options.context,
        max_prompt_tokens: options.context - options.output,
        max_output_tokens: options.output,
      },
      supports: {
        tool_calls: options.tools,
        parallel_tool_calls: options.tools,
        vision: options.vision,
        streaming: true,
        structured_outputs: options.tools,
        adaptive_thinking: options.reasoning ?? false,
        ...(options.reasoning ?
          { reasoning_effort: ["low", "medium", "high"] }
        : {}),
      },
    },
  }
}

const catalog: ModelsResponse = {
  object: "list",
  data: [
    fixtureModel("fixture-gpt-4.1", "GPT-4.1", {
      vendor: "OpenAI",
      context: 128000,
      output: 16384,
      tools: true,
      vision: true,
    }),
    fixtureModel("fixture-claude-sonnet", "Claude Sonnet", {
      vendor: "Anthropic",
      context: 200000,
      output: 32000,
      tools: true,
      vision: true,
      endpoints: ["/chat/completions"],
    }),
    fixtureModel("fixture-reasoner", "Reasoner", {
      vendor: "OpenAI",
      context: 200000,
      output: 64000,
      tools: true,
      vision: true,
      reasoning: true,
    }),
    fixtureModel("fixture-responses-only", "Responses specialist", {
      vendor: "OpenAI",
      context: 256000,
      output: 64000,
      tools: true,
      vision: true,
      reasoning: true,
      endpoints: ["/responses"],
    }),
    fixtureModel("fixture-fast", "Fast chat", {
      vendor: "GitHub",
      context: 64000,
      output: 8192,
      tools: false,
      vision: false,
      endpoints: ["/chat/completions"],
    }),
    fixtureModel("fixture-vision-preview", "Vision preview", {
      vendor: "GitHub",
      context: 128000,
      output: 16384,
      tools: true,
      vision: true,
      preview: true,
    }),
  ],
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  })
  response.end(JSON.stringify(body))
}

function failure(
  response: ServerResponse,
  status: number,
  detail: { message: string; code: string },
): void {
  json(response, status, { error: { ...detail, type: "fixture_error" } })
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Array<Buffer> = []
  let length = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    length += bytes.length
    if (length <= bodyLimit) chunks.push(bytes)
  }
  if (length > bodyLimit) throw new Error("Fixture request body is too large")
  const text = Buffer.concat(chunks).toString("utf8")
  if (
    request.headers["content-type"]?.startsWith(
      "application/x-www-form-urlencoded",
    )
  ) {
    return Object.fromEntries(new URLSearchParams(text))
  }
  return JSON.parse(text)
}

function authorized(request: IncomingMessage, token: string): boolean {
  return (
    request.headers.authorization === `Bearer ${token}`
    || request.headers.authorization === `token ${token}`
  )
}

function contentText(
  content: z.infer<typeof contentSchema> | undefined,
): string {
  if (typeof content === "string") return content
  return content?.map((part) => part.text ?? "").join(" ") ?? ""
}

function replyText(prompt: string): string {
  const addition = /\b(\d{1,8})\s*\+\s*(\d{1,8})\b/.exec(prompt)
  if (addition)
    return `${addition[1]} + ${addition[2]} = ${Number(addition[1]) + Number(addition[2])}.`
  if (/\b(?:what|which)\b.+\b(?:model|fixture)\b/i.test(prompt)) {
    return "This is the local Copilot Bridge fixture. No live model was contacted."
  }
  if (/\b(?:write|show)\b.+\b(?:code|function)\b/i.test(prompt)) {
    return '```javascript\nfunction connectionStatus() {\n  return "Copilot Bridge is connected."\n}\n```'
  }
  return "Copilot Bridge is connected."
}

function quota(id: string, unlimited: boolean) {
  return {
    entitlement: unlimited ? 0 : 300,
    overage_count: 0,
    overage_permitted: false,
    percent_remaining: unlimited ? 100 : 82,
    quota_id: id,
    quota_remaining: unlimited ? 0 : 246,
    remaining: unlimited ? 0 : 246,
    unlimited,
  }
}

interface StreamFrame {
  event?: string
  data: unknown
}

function chatFrames(
  id: string,
  model: string,
  text: string,
): Array<StreamFrame> {
  const chunk = (delta: object, finishReason: "stop" | null) => ({
    id,
    object: "chat.completion.chunk",
    created: 1793232000,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
  })
  return [
    { data: chunk({ role: "assistant", content: "" }, null) },
    ...(text.match(/\S+\s*/g) ?? []).map((part) => ({
      data: chunk({ content: part }, null),
    })),
    { data: chunk({}, "stop") },
    { data: { ...chunk({}, null), choices: [], usage } },
    { data: "[DONE]" },
  ]
}

function responseBody(id: string, model: string, text: string) {
  const item = {
    id: `msg_${id}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [], logprobs: [] }],
  }
  return {
    id,
    object: "response",
    created_at: 1793232000,
    model,
    status: "completed",
    error: null,
    incomplete_details: null,
    output: [item],
    output_text: text,
    usage: responseUsage,
    parallel_tool_calls: true,
    tools: [],
    tool_choice: "auto",
    metadata: {},
  }
}

function responsesFrames(
  id: string,
  model: string,
  text: string,
): Array<StreamFrame> {
  const completed = responseBody(id, model, text)
  const item = completed.output[0]
  const emptyPart = {
    type: "output_text",
    text: "",
    annotations: [],
    logprobs: [],
  }
  const part = { ...emptyPart, text }
  const index = { output_index: 0, content_index: 0, item_id: item.id }
  let sequence = 0
  const event = (type: string, fields: object): StreamFrame => ({
    event: type,
    data: { type, sequence_number: sequence++, ...fields },
  })
  const inProgress = {
    ...completed,
    status: "in_progress",
    output: [],
    output_text: "",
    usage: null,
  }
  return [
    event("response.created", { response: inProgress }),
    event("response.in_progress", { response: inProgress }),
    event("response.output_item.added", {
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    }),
    event("response.content_part.added", { ...index, part: emptyPart }),
    ...(text.match(/\S+\s*/g) ?? []).map((delta) =>
      event("response.output_text.delta", { ...index, delta }),
    ),
    event("response.output_text.done", { ...index, text, logprobs: [] }),
    event("response.content_part.done", { ...index, part }),
    event("response.output_item.done", { output_index: 0, item }),
    event("response.completed", { response: completed }),
  ]
}

interface FixtureState {
  oauthMode: FixtureOAuthMode
  devices: Map<string, number>
  metrics: {
    requests: number
    abortedStreams: number
    completedStreams: number
  }
  requestId: number
}

interface FixtureRequest {
  path: string
  request: IncomingMessage
  response: ServerResponse
  state: FixtureState
}

interface FixtureRoute {
  method: "GET" | "POST"
  token: "github" | "copilot" | "none"
  handle(context: FixtureRequest): void | Promise<void>
}

type Generation = z.infer<typeof generationSchema>

function stream(
  response: ServerResponse,
  options: {
    frames: Array<StreamFrame>
    long: boolean
    metrics: FixtureState["metrics"]
  },
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  })
  response.flushHeaders()
  let index = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  response.once("finish", () => {
    options.metrics.completedStreams++
  })
  response.once("close", () => {
    if (timer) clearTimeout(timer)
    if (!response.writableFinished) options.metrics.abortedStreams++
  })
  function writeNext(): void {
    if (response.destroyed) return
    const frame = options.frames.at(index++)
    if (!frame) {
      response.end()
      return
    }
    if (frame.event) response.write(`event: ${frame.event}\n`)
    response.write(
      `data: ${frame.data === "[DONE]" ? "[DONE]" : JSON.stringify(frame.data)}\n\n`,
    )
    timer = setTimeout(writeNext, options.long ? 100 : 8)
  }
  writeNext()
}

async function handleDevice({
  request,
  response,
  state,
}: FixtureRequest): Promise<void> {
  const body = deviceRequestSchema.safeParse(await readBody(request))
  if (!body.success) {
    failure(response, 400, {
      message: "A client_id is required.",
      code: "invalid_request",
    })
    return
  }
  const number = state.devices.size + 1
  const code = `fixture-device-${number}`
  state.devices.set(code, 0)
  json(response, 200, {
    device_code: code,
    user_code: `BRDG-${String(number).padStart(4, "0")}`,
    verification_uri: "https://github.com/login/device",
    expires_in: 600,
    interval: 1,
  })
}

async function handleOAuth({
  request,
  response,
  state,
}: FixtureRequest): Promise<void> {
  const body = tokenRequestSchema.safeParse(await readBody(request))
  if (!body.success) {
    failure(response, 400, {
      message: "A device_code is required.",
      code: "invalid_request",
    })
    return
  }
  const polls = state.devices.get(body.data.device_code)
  if (polls === undefined) {
    json(response, 200, { error: "expired_token" })
    return
  }
  state.devices.set(body.data.device_code, polls + 1)
  const modeErrors = {
    pending: "authorization_pending",
    denied: "access_denied",
    expired: "expired_token",
    slow: "slow_down",
  }
  if (state.oauthMode !== "approved") {
    json(response, 200, {
      error: modeErrors[state.oauthMode],
      interval: state.oauthMode === "slow" ? 6 : 1,
    })
    return
  }
  if (polls < 2) {
    json(response, 200, { error: "authorization_pending" })
    return
  }
  json(response, 200, {
    access_token: githubToken,
    token_type: "bearer",
    scope: "read:user",
  })
}

function generationPrompt(generation: Generation): string {
  if (generation.endpoint === "/chat/completions") {
    return generation.body.messages
      .filter((message) => message.role === "user")
      .map((message) => contentText(message.content))
      .join(" ")
  }
  if (typeof generation.body.input === "string") return generation.body.input
  return generation.body.input
    .filter((item) => item.role === "user" || !item.role)
    .map((item) => contentText(item.content ?? item.output))
    .join(" ")
}

function supportedGeneration(
  generation: Generation,
  response: ServerResponse,
): boolean {
  const model = catalog.data.find((entry) => entry.id === generation.body.model)
  if (!model) {
    failure(response, 400, {
      message: "Select a model from the local fixture catalog.",
      code: "model_not_found",
    })
    return false
  }
  if (!model.supported_endpoints?.includes(generation.endpoint)) {
    failure(response, 400, {
      message: "This fixture model does not support this endpoint.",
      code: "unsupported_endpoint",
    })
    return false
  }
  return true
}

function chatBody(id: string, model: string, text: string) {
  return {
    id,
    object: "chat.completion",
    created: 1793232000,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage,
  }
}

async function handleGeneration({
  path,
  request,
  response,
  state,
}: FixtureRequest): Promise<void> {
  const parsed = generationSchema.safeParse({
    endpoint: path,
    body: await readBody(request),
  })
  if (!parsed.success) {
    failure(response, 400, {
      message: "Provide a model and valid messages or input.",
      code: "invalid_request",
    })
    return
  }
  const generation = parsed.data
  if (!supportedGeneration(generation, response)) return
  const prompt = generationPrompt(generation)
  if (prompt.includes("fixture:fail")) {
    failure(response, 503, {
      message:
        "The local fixture was asked to fail. Retry without fixture:fail.",
      code: "fixture_failure",
    })
    return
  }
  const long = prompt.includes("fixture:long")
  const text =
    long ?
      `${replyText(prompt)} ${"Local fixture response continues. ".repeat(120)}`.trim()
    : replyText(prompt)
  const id = `${path === "/responses" ? "resp" : "chatcmpl"}_fixture_${++state.requestId}`
  if (generation.body.stream) {
    stream(response, {
      frames:
        path === "/responses" ?
          responsesFrames(id, generation.body.model, text)
        : chatFrames(id, generation.body.model, text),
      long,
      metrics: state.metrics,
    })
    return
  }
  const body =
    path === "/responses" ?
      responseBody(id, generation.body.model, text)
    : chatBody(id, generation.body.model, text)
  json(response, 200, body)
}

const routes: Record<string, FixtureRoute | undefined> = {
  "/login/device/code": { method: "POST", token: "none", handle: handleDevice },
  "/login/oauth/access_token": {
    method: "POST",
    token: "none",
    handle: handleOAuth,
  },
  "/user": {
    method: "GET",
    token: "github",
    handle: ({ response }) => {
      json(response, 200, { login: "octocat", name: "Mona", avatar_url: "" })
    },
  },
  "/copilot_internal/v2/token": {
    method: "GET",
    token: "github",
    handle: ({ response }) => {
      json(response, 200, {
        token: copilotToken,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_in: 1800,
      })
    },
  },
  "/copilot_internal/user": {
    method: "GET",
    token: "github",
    handle: ({ response }) => {
      json(response, 200, {
        access_type_sku: "copilot_individual",
        analytics_tracking_id: "local-fixture-only",
        assigned_date: "2026-10-01T00:00:00Z",
        can_signup_for_limited: false,
        chat_enabled: true,
        copilot_plan: "individual",
        organization_login_list: [],
        organization_list: [],
        quota_reset_date: "2026-11-01T00:00:00Z",
        quota_snapshots: {
          chat: quota("chat", true),
          completions: quota("completions", true),
          premium_interactions: quota("premium_interactions", false),
        },
      })
    },
  },
  "/models": {
    method: "GET",
    token: "copilot",
    handle: ({ response }) => {
      json(response, 200, catalog)
    },
  },
  "/chat/completions": {
    method: "POST",
    token: "copilot",
    handle: handleGeneration,
  },
  "/responses": { method: "POST", token: "copilot", handle: handleGeneration },
}

async function handle(context: FixtureRequest): Promise<void> {
  const { path, request, response, state } = context
  state.metrics.requests++
  const route = routes[path]
  if (!route) {
    failure(response, 404, {
      message: "Unknown local fixture endpoint.",
      code: "not_found",
    })
    return
  }
  if (route.method !== request.method) {
    failure(response, 405, {
      message: `Use ${route.method} for this fixture endpoint.`,
      code: "method_not_allowed",
    })
    return
  }
  const tokens = { github: githubToken, copilot: copilotToken }
  if (route.token !== "none" && !authorized(request, tokens[route.token])) {
    failure(response, 401, {
      message: "Use the synthetic token for this fixture endpoint.",
      code: "unauthorized",
    })
    return
  }
  await route.handle(context)
}

export async function startFixtureUpstream(): Promise<FixtureUpstream> {
  const state: FixtureState = {
    oauthMode: "approved",
    devices: new Map(),
    metrics: { requests: 0, abortedStreams: 0, completedStreams: 0 },
    requestId: 0,
  }
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname
    void handle({ request, response, path, state }).catch(() => {
      if (!response.headersSent && !response.destroyed)
        failure(response, 400, {
          message: "Invalid local fixture request body.",
          code: "invalid_request",
        })
      else response.destroy()
    })
  })
  server.headersTimeout = 5000
  server.requestTimeout = 10000
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("Fixture upstream did not bind a TCP port")
  let closing: Promise<void> | undefined
  return {
    origin: `http://127.0.0.1:${address.port}`,
    metrics: state.metrics,
    setOAuthMode(mode) {
      state.oauthMode = mode
    },
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
        server.closeAllConnections()
      })
      return closing
    },
  }
}
