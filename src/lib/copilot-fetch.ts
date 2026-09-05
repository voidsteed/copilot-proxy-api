import consola from "consola"

import { HTTPError } from "./error"
import { isTransientTokenError, refreshCopilotToken } from "./token"
import { sleep } from "./utils"

const DEFAULT_ATTEMPTS = 3
const RETRY_DELAY_MS = 250
const LARGE_PAYLOAD_CONTEXT_OVERFLOW_BYTES = 2_000_000

export interface CopilotFetchOptions extends RequestInit {
  attempts?: number
  retryDelayMs?: number
}

class CopilotTokenRefreshError extends Error {}

export async function copilotFetch(
  url: string,
  options: CopilotFetchOptions,
): Promise<Response> {
  const {
    attempts = DEFAULT_ATTEMPTS,
    retryDelayMs = RETRY_DELAY_MS,
    ...init
  } = options
  const bodyLength = typeof init.body === "string" ? init.body.length : 0
  const requestLabel = formatRequestLabel(url, init.method)
  let canRefreshAuth = true

  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      let response = await fetch(url, init)
      if (canRefreshAuth && isAuthFailure(response)) {
        canRefreshAuth = false
        response = await retryWithRefreshedToken(url, init, response)
      }
      if (!shouldRetryResponse(response, bodyLength) || attempt === attempts) {
        return response
      }

      consola.warn(
        `Copilot ${requestLabel} returned ${response.status}; retrying (${attempt}/${attempts})`,
      )
    } catch (error) {
      if (error instanceof CopilotTokenRefreshError) {
        const cause = error.cause
        // Concurrent refresh callers each need a readable error response body.
        throw cause instanceof HTTPError ?
            new HTTPError(
              cause.message,
              new Response(cause.response.clone().body, cause.response),
            )
          : error
      }
      lastError = error
      if (
        attempt === attempts
        || isLikelyContextOverflowTimeout(error, bodyLength)
      ) {
        throw error
      }
      consola.warn(
        `Copilot ${requestLabel} failed (${formatErrorMessage(error)}); retrying (${attempt}/${attempts})`,
      )
    }

    await sleep(retryDelayMs * attempt)
  }

  throw lastError instanceof Error ? lastError : (
      new Error("Copilot request failed")
    )
}

function isAuthFailure(response: Response): boolean {
  return response.status === 401 || response.status === 403
}

async function retryWithRefreshedToken(
  url: string,
  init: RequestInit,
  response: Response,
): Promise<Response> {
  const staleToken = getBearerToken(init.headers)
  const requestLabel = formatRequestLabel(url, init.method)

  let token: string
  try {
    token = await refreshCopilotToken(staleToken)
  } catch (error) {
    consola.warn(
      `Copilot token refresh failed after ${requestLabel} returned ${response.status}: ${formatErrorMessage(error)}`,
    )
    if (!isTransientTokenError(error)) return response
    // The shared refresh has already exhausted its own retry budget.
    throw new CopilotTokenRefreshError("Copilot token refresh failed", {
      cause: error,
    })
  }

  const headers = new Headers(init.headers)
  headers.set("Authorization", `Bearer ${token}`)
  init.headers = headers
  consola.warn(
    `Copilot ${requestLabel} returned ${response.status}; refreshed token and retrying`,
  )
  return fetch(url, init)
}

function getBearerToken(headers: RequestInit["headers"]): string | undefined {
  const authorization = new Headers(headers).get("Authorization")
  if (!authorization?.toLowerCase().startsWith("bearer ")) return undefined
  return authorization.slice(7)
}

function formatRequestLabel(url: string, method: string | undefined): string {
  const verb = method?.toUpperCase() ?? "GET"

  try {
    const parsed = new URL(url)
    return `${verb} ${parsed.pathname}`
  } catch {
    return `${verb} ${url}`
  }
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return "unknown error"
}

function shouldRetryResponse(response: Response, bodyLength: number): boolean {
  if (
    response.status >= 500
    && bodyLength > LARGE_PAYLOAD_CONTEXT_OVERFLOW_BYTES
  ) {
    return false
  }

  return (
    response.status === 408
    || response.status === 409
    || response.status === 425
    || response.status === 429
    || response.status === 499
    || response.status === 500
    || response.status === 502
    || response.status === 503
    || response.status === 504
  )
}

export function isLikelyContextOverflowTimeout(
  error: unknown,
  bodyLength: number,
): boolean {
  return (
    bodyLength > LARGE_PAYLOAD_CONTEXT_OVERFLOW_BYTES
    && error instanceof Error
    && /operation timed out|timed out/i.test(error.message)
  )
}
