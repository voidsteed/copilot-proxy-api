import type { Context } from "hono"

const CONTROL_CHARACTERS = /[\p{Cc}\u2028\u2029]/gu
const IPV4_MAPPED_PREFIX = /^::ffff:(?=\d+\.)/i
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "localhost"])

const MAX_HEADER_LENGTH = 80
const MAX_ADDRESS_LENGTH = 64
const MAX_USER_AGENT_TOKEN_LENGTH = 32

export interface RequestClientInfo {
  userAgent?: string
  origin?: string
  remoteAddress?: string
}

const clientInfoCache = new WeakMap<Context, RequestClientInfo | undefined>()

export function replaceControlCharacters(value: string): string {
  return value.replaceAll(CONTROL_CHARACTERS, "\u00b7")
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  if (maxLength <= 1) return value.slice(0, Math.max(0, maxLength))
  return `${value.slice(0, maxLength - 1)}…`
}

export function sanitizeLogText(value: string, maxLength: number): string {
  return truncateText(replaceControlCharacters(value.trim()), maxLength)
}

function stripIpv4MappedPrefix(address: string): string {
  return address.replace(IPV4_MAPPED_PREFIX, "")
}

function isLoopbackAddress(address: string): boolean {
  return LOOPBACK_ADDRESSES.has(address.toLowerCase())
}

function sanitizeOptionalText(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return truncateText(replaceControlCharacters(trimmed), maxLength)
}

function normalizeAddress(value: string | undefined): string | undefined {
  if (!value) return undefined
  const stripped = value.replaceAll(CONTROL_CHARACTERS, "").trim()
  if (!stripped) return undefined
  return truncateText(stripIpv4MappedPrefix(stripped), MAX_ADDRESS_LENGTH)
}

function extractRemoteAddress(c: Context): string | undefined {
  const rawIp = (c.req.raw as { ip?: unknown }).ip
  const peerIp = typeof rawIp === "string" ? normalizeAddress(rawIp) : undefined
  if (peerIp && !isLoopbackAddress(peerIp)) return peerIp

  const forwarded = c.req.header("x-forwarded-for")
  const forwardedHop = normalizeAddress(forwarded?.split(",")[0])
  return forwardedHop ?? peerIp
}

export function extractRequestClientInfo(
  c: Context,
): RequestClientInfo | undefined {
  if (clientInfoCache.has(c)) return clientInfoCache.get(c)

  const userAgent = sanitizeOptionalText(
    c.req.header("user-agent"),
    MAX_HEADER_LENGTH,
  )
  const origin = sanitizeOptionalText(c.req.header("origin"), MAX_HEADER_LENGTH)
  const remoteAddress = extractRemoteAddress(c)

  const info =
    userAgent || origin || remoteAddress ?
      {
        ...(userAgent ? { userAgent } : {}),
        ...(origin ? { origin } : {}),
        ...(remoteAddress ? { remoteAddress } : {}),
      }
    : undefined
  clientInfoCache.set(c, info)
  return info
}

export function formatClientLabel(
  info: RequestClientInfo | undefined,
): string | undefined {
  if (!info) return undefined

  const parts: Array<string> = []
  if (info.userAgent) {
    const firstToken = info.userAgent.trim().split(/\s+/, 1)[0]
    if (firstToken) {
      parts.push(
        truncateText(
          replaceControlCharacters(firstToken),
          MAX_USER_AGENT_TOKEN_LENGTH,
        ),
      )
    }
  }

  if (info.origin) {
    const origin = sanitizeOptionalText(info.origin, MAX_HEADER_LENGTH)
    if (origin) parts.push(origin)
  }

  if (info.remoteAddress) {
    const address = normalizeAddress(info.remoteAddress)
    if (address && (!isLoopbackAddress(address) || parts.length === 0)) {
      parts.push(address)
    }
  }

  return parts.length > 0 ? parts.join(" ") : undefined
}
