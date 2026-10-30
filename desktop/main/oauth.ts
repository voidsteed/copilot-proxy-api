import { z } from "zod"

import { GITHUB_CLIENT_ID } from "../../src/lib/api-config"
import { fetchUpstreamJson, type UpstreamOptions } from "../engine/upstream"

export const DEVICE_PAGE = "https://github.com/login/device"

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

export async function authorizeDevice(
  options: UpstreamOptions & {
    onCode(code: {
      code: string
      verificationUri: typeof DEVICE_PAGE
      expiresAt: string
    }): void
  },
): Promise<string> {
  const device = deviceSchema.parse(
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
  const expiresAt = Date.now() + device.expires_in * 1000
  options.signal.throwIfAborted()
  options.onCode({
    code: device.user_code,
    verificationUri: DEVICE_PAGE,
    expiresAt: new Date(expiresAt).toISOString(),
  })
  let intervalMs = device.interval * 1000

  while (Date.now() < expiresAt) {
    await waitForPoll(
      Math.min(intervalMs, expiresAt - Date.now()),
      options.signal,
    )
    if (Date.now() >= expiresAt) throw new DeviceFlowError("expired")
    const expiry = AbortSignal.timeout(Math.max(1, expiresAt - Date.now()))
    let response: z.infer<typeof pollSchema>
    try {
      response = pollSchema.parse(
        await fetchUpstreamJson({
          ...options,
          signal: AbortSignal.any([options.signal, expiry]),
          url: "https://github.com/login/oauth/access_token",
          init: {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json",
            },
            body: JSON.stringify({
              client_id: GITHUB_CLIENT_ID,
              device_code: device.device_code,
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            }),
          },
        }),
      )
    } catch (error) {
      options.signal.throwIfAborted()
      if (Date.now() >= expiresAt || expiry.aborted)
        throw new DeviceFlowError("expired")
      throw error
    }
    options.signal.throwIfAborted()
    if ("access_token" in response) return response.access_token
    switch (response.error) {
      case "authorization_pending": {
        break
      }
      case "slow_down": {
        intervalMs = Math.max(
          intervalMs + 5000,
          (response.interval ?? 0) * 1000,
        )
        break
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
  throw new DeviceFlowError("expired")
}
