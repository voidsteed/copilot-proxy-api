import type { Context, MiddlewareHandler } from "hono"

import consola from "consola"
import { colors } from "consola/utils"

import { state } from "./state"

const MAX_JSON_BODY_CHARS = 2_000_000
const MAX_SSE_LINE_CHARS = 512_000
const ROUTE_COLUMN_WIDTH = 26
// Wide enough to distinguish every model this proxy maps to: `claude-sonnet-5`
// and `claude-sonnet-4.6` both truncated to `claude-sonnet…` at 14, which hides
// exactly what translateModelName() decided.
const MODEL_COLUMN_WIDTH = 18
const EFFORT_COLUMN_WIDTH = 7
const TOKEN_COLUMN_WIDTH = 4
const CACHE_COLUMN_WIDTH = 6 + TOKEN_COLUMN_WIDTH

interface RequestLogMetadata {
  effort?: string | null
  model?: string | null
}

interface RequestLogState extends RequestLogMetadata {
  cachedTokens?: number
  finished: boolean
  inputTokens?: number
  outputTokens?: number
  startedAtMs: number
}

interface RequestLogSummary extends RequestLogMetadata {
  cachedTokens?: number
  contextLimit?: number
  durationMs: number
  error?: string
  inputTokens?: number
  method: string
  outputTokens?: number
  path: string
  status: number
}

interface FinishRequestLogOptions {
  c: Context
  error?: string
  requestState: RequestLogState
  status: number
  writeLog: LogWriter
}

type LogWriter = (line: string) => void

/** Control characters (C0, DEL, C1) that could forge log lines or drive a terminal. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/g

const requestLogStates = new WeakMap<Context, RequestLogState>()

export function setRequestLogMetadata(
  c: Context,
  metadata: RequestLogMetadata,
): void {
  const requestState = requestLogStates.get(c)
  if (!requestState) return

  if (metadata.model !== undefined) requestState.model = metadata.model
  if (metadata.effort !== undefined) requestState.effort = metadata.effort
}

export function createRequestLogMiddleware(
  writeLog: LogWriter = (line) => consola.info(line),
): MiddlewareHandler {
  return async (c, next) => {
    const requestState: RequestLogState = {
      finished: false,
      startedAtMs: performance.now(),
    }
    requestLogStates.set(c, requestState)

    try {
      await next()
    } catch (error) {
      finishRequestLog({
        c,
        requestState,
        status: 500,
        writeLog,
        error: error instanceof Error ? error.message : "Unknown error",
      })
      throw error
    }

    const response = c.res
    const contentType = response.headers.get("content-type") ?? ""
    const isEventStream = contentType.includes("text/event-stream")

    if (!response.body) {
      finishRequestLog({
        c,
        requestState,
        status: response.status,
        writeLog,
      })
      return
    }

    // Non-streaming responses are logged as soon as the handler returns, not
    // when their body is drained. A body nobody reads — `HEAD /`, a client that
    // hangs up, an internal `app.request()` — would otherwise never reach the
    // observer's end-of-stream, and the request would vanish from the log
    // entirely. hono/logger logged unconditionally; this preserves that.
    if (!isEventStream) {
      await collectBufferedMetrics(response, requestState, contentType)
      finishRequestLog({
        c,
        requestState,
        status: response.status,
        writeLog,
      })
      return
    }

    const observer = new ResponseMetricsObserver(requestState, contentType)
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    const observedBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await reader.read()
          if (result.done) {
            observer.finish()
            finishRequestLog({
              c,
              requestState,
              status: response.status,
              writeLog,
            })
            controller.close()
            return
          }

          observer.push(result.value)
          controller.enqueue(result.value)
        } catch (error) {
          observer.finish()
          finishRequestLog({
            c,
            requestState,
            status: response.status,
            writeLog,
            error:
              error instanceof Error ? error.message : "Response stream failed",
          })
          controller.error(error)
        }
      },
      async cancel(reason) {
        observer.finish()
        finishRequestLog({
          c,
          requestState,
          status: response.status,
          writeLog,
        })
        await reader.cancel(reason)
      },
    })

    c.res = new Response(observedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}

export const requestLogMiddleware = createRequestLogMiddleware()

/**
 * Read usage counts out of an already-buffered response. Cloning is cheap here
 * because the body is fully in memory by the time the handler has returned, and
 * it leaves the original untouched for the client.
 */
async function collectBufferedMetrics(
  response: Response,
  requestState: RequestLogState,
  contentType: string,
): Promise<void> {
  try {
    const body = await response.clone().text()
    if (!body) return

    const observer = new ResponseMetricsObserver(requestState, contentType)
    observer.pushText(body)
    observer.finish()
  } catch (readError) {
    consola.debug("Failed to read response body for metrics:", readError)
  }
}

export function formatRequestLogLine(summary: RequestLogSummary): string {
  const request = `${summary.method} ${summary.path}`
  const segments = [
    `  --> ${padColumn(request, ROUTE_COLUMN_WIDTH)} ${formatStatus(summary.status)}`,
  ]

  if (summary.model) {
    const effort =
      summary.effort ?
        padColumn(summary.effort, EFFORT_COLUMN_WIDTH)
      : " ".repeat(EFFORT_COLUMN_WIDTH)
    segments.push(
      `${colors.cyan(padColumn(summary.model, MODEL_COLUMN_WIDTH))} ${colors.magenta(effort)}`,
    )
  }

  if (summary.inputTokens !== undefined || summary.outputTokens !== undefined) {
    const cache =
      (summary.cachedTokens ?? 0) > 0 ?
        colors.yellow(`cache ${formatTokenColumn(summary.cachedTokens)}`)
      : " ".repeat(CACHE_COLUMN_WIDTH)
    segments.push(
      `tokens ↑ ${colors.cyan(formatTokenColumn(summary.inputTokens))} ${cache} ↓ ${colors.green(formatTokenColumn(summary.outputTokens))}`,
    )
  }

  if (summary.inputTokens !== undefined) {
    const context =
      summary.contextLimit ?
        `${formatTokens(summary.inputTokens)}/${formatTokens(summary.contextLimit)} (${Math.round((summary.inputTokens / summary.contextLimit) * 100)}%)`
      : formatTokens(summary.inputTokens)
    segments.push(`context ${colors.dim(context)}`)
  }

  const e2e = formatDuration(summary.durationMs)
  segments.push(`total ${colors.green(e2e)}`)

  if (summary.error) segments.push(colors.red(summary.error))
  return segments.join(" │ ")
}

class ResponseMetricsObserver {
  private readonly decoder = new TextDecoder()
  private readonly isEventStream: boolean
  private readonly requestState: RequestLogState
  private jsonBody = ""
  private sseBuffer = ""
  private skippingOversizedLine = false

  constructor(requestState: RequestLogState, contentType: string) {
    this.requestState = requestState
    this.isEventStream = contentType.includes("text/event-stream")
  }

  push(chunk: Uint8Array): void {
    const text = this.decoder.decode(chunk, { stream: true })
    if (this.isEventStream) {
      this.pushSSEText(text)
      return
    }

    this.pushText(text)
  }

  /**
   * Feed already-decoded text. Non-streaming responses take this path: their
   * body is read once, in full, after the handler returns, so there is nothing
   * to accumulate across chunks.
   */
  pushText(text: string): void {
    if (this.isEventStream) {
      this.pushSSEText(text)
      return
    }

    const remaining = MAX_JSON_BODY_CHARS - this.jsonBody.length
    if (remaining > 0) this.jsonBody += text.slice(0, remaining)
  }

  finish(): void {
    const finalText = this.decoder.decode()
    if (this.isEventStream) {
      this.pushSSEText(finalText + "\n")
      return
    }

    const remaining = MAX_JSON_BODY_CHARS - this.jsonBody.length
    if (remaining > 0) this.jsonBody += finalText.slice(0, remaining)
    if (!this.jsonBody) return

    try {
      mergeResponseMetrics(
        this.requestState,
        JSON.parse(this.jsonBody) as unknown,
      )
    } catch {
      // Non-JSON error responses still receive a basic request log line.
    }
  }

  private pushSSEText(text: string): void {
    let remainingText = text
    if (this.skippingOversizedLine) {
      const newlineIndex = remainingText.indexOf("\n")
      if (newlineIndex === -1) return
      this.skippingOversizedLine = false
      remainingText = remainingText.slice(newlineIndex + 1)
    }

    this.sseBuffer += remainingText
    let newlineIndex = this.sseBuffer.indexOf("\n")
    while (newlineIndex !== -1) {
      const line = this.sseBuffer.slice(0, newlineIndex).replace(/\r$/, "")
      this.sseBuffer = this.sseBuffer.slice(newlineIndex + 1)
      this.processSSELine(line)
      newlineIndex = this.sseBuffer.indexOf("\n")
    }

    if (this.sseBuffer.length > MAX_SSE_LINE_CHARS) {
      this.sseBuffer = ""
      this.skippingOversizedLine = true
    }
  }

  private processSSELine(line: string): void {
    if (!line.startsWith("data:")) return
    const data = line.slice(5).trimStart()
    if (!data || data === "[DONE]" || data.length > MAX_SSE_LINE_CHARS) return

    try {
      mergeResponseMetrics(this.requestState, JSON.parse(data) as unknown)
    } catch {
      // Ignore malformed or non-JSON SSE data while preserving the stream.
    }
  }
}

function mergeResponseMetrics(
  requestState: RequestLogState,
  value: unknown,
): void {
  if (!isRecord(value)) return

  for (const container of [
    value,
    isRecord(value.response) ? value.response : undefined,
    isRecord(value.message) ? value.message : undefined,
  ]) {
    if (!container || !isRecord(container.usage)) continue
    mergeUsage(requestState, container.usage)
  }
}

function mergeUsage(
  requestState: RequestLogState,
  usage: Record<string, unknown>,
): void {
  const cacheRead = numberValue(usage.cache_read_input_tokens)
  const cacheCreation = numberValue(usage.cache_creation_input_tokens)
  const input =
    numberValue(usage.prompt_tokens) ?? numberValue(usage.input_tokens)
  const output =
    numberValue(usage.completion_tokens) ?? numberValue(usage.output_tokens)
  const cached =
    cacheRead
    ?? nestedNumberValue(usage.prompt_tokens_details, "cached_tokens")
    ?? nestedNumberValue(usage.input_tokens_details, "cached_tokens")

  if (input !== undefined) {
    const inputExcludesCachedTokens =
      usage.prompt_tokens === undefined
      && (cacheRead !== undefined || cacheCreation !== undefined)
    requestState.inputTokens =
      inputExcludesCachedTokens ?
        input + (cacheRead ?? 0) + (cacheCreation ?? 0)
      : input
  }
  if (output !== undefined) requestState.outputTokens = output
  if (cached !== undefined) requestState.cachedTokens = cached
}

function finishRequestLog(options: FinishRequestLogOptions): void {
  const { c, error, requestState, status, writeLog } = options
  if (requestState.finished) return
  requestState.finished = true

  const endedAtMs = performance.now()

  // Observability must never be able to break request handling. Callers run
  // inside the response-body observer, where a throw would error the stream
  // and hand the client a truncated body instead of its response.
  try {
    const contextLimit = state.models?.data.find(
      (model) => model.id === requestState.model,
    )?.capabilities.limits.max_context_window_tokens

    writeLog(
      formatRequestLogLine({
        method: c.req.method,
        path: c.req.path,
        status,
        model: requestState.model,
        effort: requestState.effort,
        inputTokens: requestState.inputTokens,
        outputTokens: requestState.outputTokens,
        cachedTokens: requestState.cachedTokens,
        contextLimit,
        durationMs: endedAtMs - requestState.startedAtMs,
        error,
      }),
    )
  } catch (logError) {
    consola.debug("Failed to write request log line:", logError)
  }
}

function nestedNumberValue(value: unknown, key: string): number | undefined {
  return isRecord(value) ? numberValue(value[key]) : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/**
 * Render an untrusted string into a fixed-width column.
 *
 * `model` and `effort` arrive from client JSON that is only structurally typed
 * by a `c.req.json<T>()` cast, so at runtime they can be any JSON value. Three
 * things have to hold regardless of what a client sends:
 *
 *   - Non-strings must not throw. An exception here escapes through the
 *     response-body observer and destroys the client's response.
 *   - Control characters must not survive. A newline would let a caller forge
 *     an extra log line; an ESC would let it repaint the operator's terminal.
 *   - Width is bounded by the column, so a huge string cannot flood the log.
 */
function padColumn(value: unknown, width: number): string {
  const text = typeof value === "string" ? value : String(value)
  const safe = text.replaceAll(CONTROL_CHARACTERS, "\u00b7")
  if (safe.length <= width) return safe.padEnd(width)
  return `${safe.slice(0, Math.max(1, width - 1))}…`
}

function formatStatus(status: number): string {
  const value = String(status).padStart(3)
  if (status >= 500) return colors.red(value)
  if (status >= 400) return colors.yellow(value)
  if (status >= 300) return colors.cyan(value)
  return colors.green(value)
}

function formatTokenColumn(value: number | undefined): string {
  return (value === undefined ? "—" : formatTokens(value)).padStart(
    TOKEN_COLUMN_WIDTH,
  )
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${formatCompactNumber(value / 1_000_000)}M`
  if (value >= 1_000) return `${formatCompactNumber(value / 1_000)}K`
  return Math.round(value).toString()
}

function formatCompactNumber(value: number): string {
  if (Number.isInteger(value)) return value.toString()
  return value >= 10 ? Math.round(value).toString() : value.toFixed(1)
}

function formatDuration(value: number): string {
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}s`
  return `${Math.max(0, Math.round(value))}ms`
}
