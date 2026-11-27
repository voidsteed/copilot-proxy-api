import { z } from "zod"

import { GITHUB_CLIENT_ID } from "../../src/lib/api-config"
import {
  fetchUpstreamJson,
  UpstreamError,
  type UpstreamOptions,
} from "../engine/upstream"

export const DEVICE_PAGE = "https://github.com/login/device"

const MAX_TRANSIENT_POLL_ERRORS = 5
const MAX_TRANSIENT_BACKOFF_MS = 30_000

const deviceSchema = z.object({
  device_code: z.string().min(1).max(4096),
  user_code: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[A-Z0-9-]+$/i),
  verification_uri: z.literal(DEVICE_PAGE),
  expires_in: z.number().positive().max(86_400),
  interval: z.number().positive().max(3600).default(5),
})

const pollSchema = z.union([
  z.object({ access_token: z.string().min(1).max(16_384) }),
  z.object({
    error: z.string().max(80),
    interval: z.number().positive().optional(),
  }),
])

export class DeviceFlowError extends Error {
  readonly kind: "expired" | "denied" | "failed"

  constructor(kind: DeviceFlowError["kind"]) {
    super(kind)
    this.kind = kind
  }
}

export function waitForPoll(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(new DOMException("Cancelled", "AbortError"))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve()
    }, delayMs)
    signal.addEventListener("abort", abort, { once: true })
  })
}

async function pollDeviceToken(
  options: UpstreamOptions,
  deviceCode: string,
): Promise<z.infer<typeof pollSchema>> {
  return pollSchema.parse(
    await fetchUpstreamJson({
      ...options,
      url: "https://github.com/login/oauth/access_token",
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      },
    }),
  )
}

function isTransientPollError(error: unknown): boolean {
  return (
    error instanceof UpstreamError
    && (error.kind === "network" || error.kind === "unavailable")
  )
}

async function requestDeviceCode(
  options: UpstreamOptions,
): Promise<z.infer<typeof deviceSchema>> {
  return deviceSchema.parse(
    await fetchUpstreamJson({
      ...options,
      url: "https://github.com/login/device/code",
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          scope: "read:user",
        }),
      },
    }),
  )
}

function nextIntervalAfterError(
  response: Extract<z.infer<typeof pollSchema>, { error: string }>,
  intervalMs: number,
): number {
  switch (response.error) {
    case "authorization_pending": {
      return intervalMs
    }
    case "slow_down": {
      return Math.max(intervalMs + 5000, (response.interval ?? 0) * 1000)
    }
    case "expired_token": {
      throw new DeviceFlowError("expired")
    }
    case "access_denied": {
      throw new DeviceFlowError("denied")
    }
    default: {
      throw new DeviceFlowError("failed")
    }
  }
}

export async function authorizeDevice(
  options: UpstreamOptions & {
    onCode(code: {
      code: string
      verificationUri: typeof DEVICE_PAGE
      expiresAt: string
    }): void
  },
): Promise<string> {
  const device = await requestDeviceCode(options)
  const expiresAt = Date.now() + device.expires_in * 1000
  options.signal.throwIfAborted()
  options.onCode({
    code: device.user_code,
    verificationUri: DEVICE_PAGE,
    expiresAt: new Date(expiresAt).toISOString(),
  })

  const expiryAbort = new AbortController()
  const isExpired = () => Date.now() >= expiresAt || expiryAbort.signal.aborted
  const expiryTimer = setTimeout(
    () => expiryAbort.abort(),
    Math.max(1, expiresAt - Date.now()),
  )
  const pollSignal = AbortSignal.any([options.signal, expiryAbort.signal])
  let intervalMs = device.interval * 1000
  let nextDelayMs = intervalMs
  let transientErrors = 0

  try {
    while (!isExpired()) {
      await waitForPoll(
        Math.min(nextDelayMs, Math.max(0, expiresAt - Date.now())),
        options.signal,
      )
      if (isExpired()) throw new DeviceFlowError("expired")
      let response: z.infer<typeof pollSchema>
      try {
        response = await pollDeviceToken(
          { fixtureOrigin: options.fixtureOrigin, signal: pollSignal },
          device.device_code,
        )
      } catch (error) {
        options.signal.throwIfAborted()
        if (isExpired()) throw new DeviceFlowError("expired")
        if (
          !isTransientPollError(error)
          || ++transientErrors >= MAX_TRANSIENT_POLL_ERRORS
        )
          throw error
        nextDelayMs = Math.min(
          intervalMs * 2 ** (transientErrors - 1),
          MAX_TRANSIENT_BACKOFF_MS,
        )
        continue
      }
      options.signal.throwIfAborted()
      transientErrors = 0
      if ("access_token" in response) return response.access_token
      intervalMs = nextIntervalAfterError(response, intervalMs)
      nextDelayMs = intervalMs
    }
    throw new DeviceFlowError("expired")
  } finally {
    clearTimeout(expiryTimer)
  }
}
