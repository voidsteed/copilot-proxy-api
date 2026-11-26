import type { ResponsesApiRequest } from "~/routes/responses/types"

interface OutputItemIdentity {
  id: string
  type?: string
}

const replayIds = new Map<string, { id: string; expires: number }>()
const TTL_MS = 30 * 60 * 1000
const MAX_REPLAY_IDS = 4096
const MAX_EVENT_CHARS = 2_000_000

function remember(scope: string, clientId: string, upstreamId: string): void {
  const key = `${scope}:${clientId}`
  replayIds.delete(key)
  replayIds.set(key, { id: upstreamId, expires: Date.now() + TTL_MS })
  while (replayIds.size > MAX_REPLAY_IDS) {
    const oldest = replayIds.keys().next().value
    if (oldest === undefined) break
    replayIds.delete(oldest)
  }
}

export function restoreResponsesReplayIds(
  payload: ResponsesApiRequest,
  scope: string,
): ResponsesApiRequest {
  if (!Array.isArray(payload.input)) return payload
  return {
    ...payload,
    input: payload.input.map((item) => {
      if (!isRecord(item) || typeof item.id !== "string") return item
      const key = `${scope}:${item.id}`
      const entry = replayIds.get(key)
      if (!entry) return item
      const now = Date.now()
      if (entry.expires <= now) {
        replayIds.delete(key)
        return item
      }
      replayIds.delete(key)
      replayIds.set(key, { id: entry.id, expires: now + TTL_MS })
      return { ...item, id: entry.id }
    }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function normalizeBlock(
  block: string,
  ids: Map<number, OutputItemIdentity>,
  scope: string,
): string {
  const lines = block.split(/\r\n|\r|\n/)
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
  if (!data || data === "[DONE]") return block
  let event: unknown
  try {
    event = JSON.parse(data) as unknown
  } catch {
    return block
  }
  if (!isRecord(event)) return block
  let changed = normalizeIndexedEvent(event, ids, scope)
  if (
    event.type === "response.completed"
    || event.type === "response.incomplete"
  ) {
    changed = normalizeCompletedOutput(event.response, ids, scope) || changed
  }
  if (!changed) return block
  return [
    ...lines.filter((line) => !line.startsWith("data:")),
    `data: ${JSON.stringify(event)}`,
  ].join("\n")
}

function normalizeIndexedEvent(
  event: Record<string, unknown>,
  ids: Map<number, OutputItemIdentity>,
  scope: string,
): boolean {
  const index = event.output_index
  if (typeof index !== "number") return false
  const item = isRecord(event.item) ? event.item : undefined
  if (
    event.type === "response.output_item.added"
    && typeof item?.id === "string"
    && item.id.length > 0
  ) {
    ids.set(index, {
      id: item.id,
      type: typeof item.type === "string" ? item.type : undefined,
    })
  }
  const expected = ids.get(index)
  if (!expected) return false
  let changed = false
  if (typeof event.item_id === "string" && event.item_id !== expected.id) {
    event.item_id = expected.id
    changed = true
  }
  return (
    normalizeItemId(
      item,
      expected,
      event.type === "response.output_item.done" ? scope : undefined,
    ) || changed
  )
}

function normalizeItemId(
  item: unknown,
  expected: OutputItemIdentity,
  scope?: string,
): boolean {
  if (
    !isRecord(item)
    || typeof item.id !== "string"
    || item.id.length === 0
    || item.id === expected.id
  ) {
    return false
  }
  if (
    expected.type
    && typeof item.type === "string"
    && item.type !== expected.type
  ) {
    return false
  }
  if (scope) remember(scope, expected.id, item.id)
  item.id = expected.id
  return true
}

function normalizeCompletedOutput(
  response: unknown,
  ids: Map<number, OutputItemIdentity>,
  scope: string,
): boolean {
  if (!isRecord(response) || !Array.isArray(response.output)) return false
  let changed = false
  for (const [index, item] of response.output.entries()) {
    const expected = ids.get(index)
    if (expected && normalizeItemId(item, expected, scope)) {
      changed = true
    }
  }
  return changed
}

/** Copilot rotates opaque item IDs between added, delta, and done events. */
export function normalizeResponsesStreamIdentity(
  response: Response,
  scope: string,
): Response {
  if (
    !response.body
    || !response.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("text/event-stream")
  ) {
    return response
  }
  const ids = new Map<number, OutputItemIdentity>()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const boundaryPattern = /\r\n\r\n|\r\r|\n\n/g
  let buffer = ""
  let searchFrom = 0
  let passthrough = false
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true })
      if (passthrough) {
        if (text.length > 0) controller.enqueue(encoder.encode(text))
        return
      }
      if (text.length === 0) return
      buffer += text
      let blockStart = 0
      boundaryPattern.lastIndex = searchFrom
      let boundary = boundaryPattern.exec(buffer)
      while (boundary !== null) {
        controller.enqueue(
          encoder.encode(
            normalizeBlock(buffer.slice(blockStart, boundary.index), ids, scope)
              + boundary[0],
          ),
        )
        blockStart = boundary.index + boundary[0].length
        boundary = boundaryPattern.exec(buffer)
      }
      if (blockStart > 0) buffer = buffer.slice(blockStart)
      if (buffer.length > MAX_EVENT_CHARS) {
        controller.enqueue(encoder.encode(buffer))
        buffer = ""
        searchFrom = 0
        passthrough = true
        return
      }
      searchFrom = Math.max(0, buffer.length - 3)
    },
    flush(controller) {
      const tail = passthrough ? decoder.decode() : buffer + decoder.decode()
      if (tail.length === 0) return
      controller.enqueue(
        encoder.encode(passthrough ? tail : normalizeBlock(tail, ids, scope)),
      )
    },
  })
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  return new Response(
    (response.body as ReadableStream<Uint8Array>).pipeThrough(transform),
    { status: response.status, statusText: response.statusText, headers },
  )
}
