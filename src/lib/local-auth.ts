import type { MiddlewareHandler } from "hono"

import { state } from "./state"

export function parseLocalApiKeys(value: string | undefined): Array<string> {
  if (!value) return []
  return value
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0)
}

export const optionalLocalAuth: MiddlewareHandler = async (c, next) => {
  if (state.localApiKeys.length === 0 || c.req.method === "OPTIONS") {
    await next()
    return
  }

  const bearerToken = extractBearerToken(c.req.header("authorization"))
  const apiKey = c.req.header("x-api-key")?.trim()
  const googleKey = c.req.header("x-goog-api-key")?.trim()

  if (
    (bearerToken && state.localApiKeys.includes(bearerToken))
    || (apiKey && state.localApiKeys.includes(apiKey))
    || (googleKey && state.localApiKeys.includes(googleKey))
  ) {
    await next()
    return
  }

  if (
    c.req.path === "/v1beta/models"
    || c.req.path.startsWith("/v1beta/models/")
  ) {
    return c.json(
      {
        error: {
          code: 401,
          status: "UNAUTHENTICATED",
          message: "Missing or invalid API key",
        },
      },
      401,
    )
  }

  return c.json(
    {
      error: {
        message: "Missing or invalid API key",
        type: "authentication_error",
      },
    },
    401,
  )
}

function extractBearerToken(
  authorization: string | undefined,
): string | undefined {
  if (!authorization) return undefined

  const prefix = "bearer "
  if (!authorization.toLowerCase().startsWith(prefix)) return undefined

  const token = authorization.slice(prefix.length).trim()
  return token.length > 0 ? token : undefined
}
