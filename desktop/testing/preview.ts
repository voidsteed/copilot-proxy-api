import type { IncomingMessage, ServerResponse } from "node:http"

import { readFile, realpath, stat } from "node:fs/promises"
import { createServer } from "node:http"
import { extname, isAbsolute, relative, resolve, sep } from "node:path"

import type { DesktopController } from "../main/types"

import { commandSchema, snapshotSchema } from "../shared/contracts"

interface PreviewOptions {
  controller: DesktopController
  rendererDirectory: string
  port?: number
}

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  })
  response.end(JSON.stringify(body))
}

function inside(directory: string, path: string): boolean {
  const difference = relative(directory, path)
  return (
    difference !== ".."
    && !difference.startsWith(`..${sep}`)
    && !isAbsolute(difference)
  )
}

async function commandBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Array<Buffer> = []
  let length = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    length += bytes.length
    if (length <= 65536) chunks.push(bytes)
  }
  if (length > 65536) throw new Error("Command body exceeds preview limit")
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

interface PreviewState {
  controller: DesktopController
  directory: string
  clients: Set<ServerResponse>
  origin: string
}

interface PreviewRequest {
  request: IncomingMessage
  response: ServerResponse
  state: PreviewState
}

class PreviewHTTPError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "PreviewHTTPError"
    this.status = status
  }
}

function requestPath(request: IncomingMessage): string {
  const rawPath = (request.url ?? "/").split("?")[0]
  let path: string
  try {
    path = decodeURIComponent(rawPath)
  } catch {
    throw new PreviewHTTPError(400, "Invalid request path.")
  }
  if (
    !path.startsWith("/")
    || path.includes("\\")
    || path.includes("\0")
    || path.split("/").includes("..")
  ) {
    throw new PreviewHTTPError(403, "Invalid request path.")
  }
  return path
}

function checkAccess({ request, state }: PreviewRequest): void {
  if (
    request.headers.host !== new URL(state.origin).host
    || (request.headers.origin !== undefined
      && request.headers.origin !== state.origin)
    || request.headers["sec-fetch-site"] === "cross-site"
  ) {
    throw new PreviewHTTPError(
      403,
      "Preview access requires the local preview origin.",
    )
  }
  if (!state.controller.snapshot().fixture)
    throw new PreviewHTTPError(403, "Fixture preview is unavailable.")
}

async function invokeCommand({
  request,
  response,
  state,
}: PreviewRequest): Promise<void> {
  if (request.headers.origin !== state.origin)
    throw new PreviewHTTPError(
      403,
      "Commands require the local preview origin.",
    )
  if (
    request.headers["content-type"]?.split(";")[0].trim() !== "application/json"
  ) {
    throw new PreviewHTTPError(415, "Commands require application/json.")
  }
  let input: unknown
  try {
    input = await commandBody(request)
  } catch {
    throw new PreviewHTTPError(400, "Invalid or oversized preview command.")
  }
  const parsed = commandSchema.safeParse(input)
  if (!parsed.success)
    throw new PreviewHTTPError(400, "Invalid preview command.")
  json(
    response,
    200,
    snapshotSchema.parse(await state.controller.invoke(parsed.data)),
  )
}

function subscribeEvents({ response, state }: PreviewRequest): void {
  const initial = snapshotSchema.parse(state.controller.snapshot())
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  })
  response.flushHeaders()
  const unsubscribe = state.controller.subscribe((snapshot) => {
    const parsed = snapshotSchema.safeParse(snapshot)
    if (parsed.success && parsed.data.fixture && !response.destroyed) {
      response.write(
        `event: snapshot\ndata: ${JSON.stringify(parsed.data)}\n\n`,
      )
    } else response.end()
  })
  state.clients.add(response)
  response.once("close", () => {
    state.clients.delete(response)
    unsubscribe()
  })
  response.write(`event: snapshot\ndata: ${JSON.stringify(initial)}\n\n`)
}

async function rendererFile(directory: string, path: string): Promise<string> {
  const candidate = resolve(directory, `.${path}`)
  if (!inside(directory, candidate))
    throw new PreviewHTTPError(403, "Invalid renderer path.")
  let file: string
  try {
    file = await realpath(candidate)
    if (!inside(directory, file))
      throw new PreviewHTTPError(403, "Invalid renderer path.")
    if (!(await stat(file)).isFile())
      file = await realpath(resolve(directory, "index.html"))
  } catch (error) {
    if (error instanceof PreviewHTTPError) throw error
    if (
      error instanceof Error
      && "code" in error
      && error.code === "ENOENT"
      && !extname(path)
    ) {
      file = await realpath(resolve(directory, "index.html"))
    } else throw new PreviewHTTPError(404, "Renderer file not found.")
  }
  if (!inside(directory, file))
    throw new PreviewHTTPError(403, "Invalid renderer path.")
  return file
}

async function serveRenderer(
  context: PreviewRequest,
  path: string,
): Promise<void> {
  const { request, response, state } = context
  if (request.method !== "GET" && request.method !== "HEAD")
    throw new PreviewHTTPError(405, "Use GET or HEAD for renderer files.")
  const file = await rendererFile(state.directory, path)
  const data = await readFile(file)
  response.writeHead(200, {
    "content-type": mimeTypes[extname(file)] ?? "application/octet-stream",
    "content-length": data.length,
    "cache-control": "no-store",
  })
  response.end(request.method === "HEAD" ? undefined : data)
}

async function handlePreview(context: PreviewRequest): Promise<void> {
  const { request, response, state } = context
  response.setHeader("x-content-type-options", "nosniff")
  response.setHeader("referrer-policy", "no-referrer")
  response.setHeader(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  )
  checkAccess(context)
  const path = requestPath(request)
  if (path === "/__desktop/snapshot" && request.method === "GET") {
    json(response, 200, snapshotSchema.parse(state.controller.snapshot()))
    return
  }
  if (path === "/__desktop/command" && request.method === "POST") {
    await invokeCommand(context)
    return
  }
  if (path === "/__desktop/events" && request.method === "GET") {
    subscribeEvents(context)
    return
  }
  if (path.startsWith("/__desktop/"))
    throw new PreviewHTTPError(404, "Unknown preview endpoint.")
  await serveRenderer(context, path)
}

export async function startPreviewServer({
  controller,
  rendererDirectory,
  port = 0,
}: PreviewOptions): Promise<{ origin: string; close(): Promise<void> }> {
  if (!controller.snapshot().fixture)
    throw new Error("HTTP preview is available only with fixture data")
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Invalid preview port")
  const directory = await realpath(rendererDirectory)
  if (!(await stat(directory)).isDirectory())
    throw new Error("Renderer directory is not a directory")
  const state: PreviewState = {
    controller,
    directory,
    clients: new Set(),
    origin: "",
  }
  const server = createServer((request, response) => {
    void handlePreview({ request, response, state }).catch((error: unknown) => {
      if (!response.headersSent && !response.destroyed) {
        const status = error instanceof PreviewHTTPError ? error.status : 500
        const message =
          error instanceof PreviewHTTPError ?
            error.message
          : "Preview request failed."
        json(response, status, { error: message })
      } else response.destroy()
    })
  })
  server.headersTimeout = 5000
  server.requestTimeout = 10000
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("Preview did not bind a TCP port")
  state.origin = `http://127.0.0.1:${address.port}`
  let closing: Promise<void> | undefined
  return {
    origin: state.origin,
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        for (const client of state.clients) client.end()
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
