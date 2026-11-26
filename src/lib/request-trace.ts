import type { MiddlewareHandler } from "hono"

import { randomUUID } from "node:crypto"

import { extractRequestClientInfo, type RequestClientInfo } from "./client-info"

const MAX_REQUEST_TRACES = 100

export interface RequestTrace {
  id: string
  method: string
  path: string
  status: number
  ok: boolean
  durationMs: number
  startedAt: string
  error?: string
  client?: RequestClientInfo
}

const requestTraces: Array<RequestTrace> = []

function createRequestId(): string {
  return `req_${randomUUID().replaceAll("-", "")}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error"
}

function addRequestTrace(trace: RequestTrace): void {
  requestTraces.unshift(trace)
  if (requestTraces.length > MAX_REQUEST_TRACES) {
    requestTraces.length = MAX_REQUEST_TRACES
  }
}

export function getRequestTraces(): Array<RequestTrace> {
  return [...requestTraces]
}

export function clearRequestTraces(): void {
  requestTraces.length = 0
}

export const requestTraceMiddleware: MiddlewareHandler = async (c, next) => {
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()
  const client = extractRequestClientInfo(c)
  const requestId =
    c.req.header("x-client-request-id")
    ?? c.req.header("x-request-id")
    ?? createRequestId()

  c.header("request-id", requestId)
  c.header("x-request-id", requestId)

  let error: string | undefined
  try {
    await next()
  } catch (caught) {
    error = errorMessage(caught)
    throw caught
  } finally {
    const finalRequestId =
      c.res.headers.get("x-request-id")
      ?? c.res.headers.get("request-id")
      ?? requestId
    const status = error ? 500 : c.res.status
    addRequestTrace({
      id: finalRequestId,
      method: c.req.method,
      path: c.req.path,
      status,
      ok: !error && status < 400,
      durationMs: Date.now() - startedAtMs,
      startedAt,
      error,
      ...(client ? { client } : {}),
    })
  }
}
