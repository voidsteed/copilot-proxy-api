import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { z } from "zod"

import { upstreamCatalogSchema } from "../engine/upstream"
import { startFixtureUpstream } from "./upstream"

async function readBody(request: IncomingMessage): Promise<string> {
  let raw = ""
  for await (const chunk of request)
    raw += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)
  return raw
}
async function sendFixtureResponse(options: {
  path: string
  otherUser: boolean
  response: Response
  outgoing: ServerResponse
}): Promise<void> {
  const { path, response, outgoing } = options
  outgoing.writeHead(response.status, {
    "content-type": response.headers.get("content-type") ?? "application/json",
  })
  if (path === "/user" && options.otherUser) {
    await response.body?.cancel()
    outgoing.end(JSON.stringify({ login: "othercat", name: "Other user" }))
    return
  }
  if (path === "/login/device/code") {
    const device = z
      .record(z.string(), z.unknown())
      .parse(await response.json())
    outgoing.end(JSON.stringify({ ...device, interval: 0.01 }))
    return
  }
  if (path === "/models") {
    const catalog = upstreamCatalogSchema.parse(await response.json())
    const first = catalog.data.at(0)
    if (!first) throw new Error("The fixture needs a source model")
    outgoing.end(
      JSON.stringify({
        ...catalog,
        data: [
          ...catalog.data,
          {
            ...first,
            id: "fixture-embeddings",
            supported_endpoints: ["/embeddings"],
            capabilities: { ...first.capabilities, type: "embeddings" },
          },
        ],
      }),
    )
    return
  }
  const reader = response.body?.getReader()
  if (reader)
    while (true) {
      const item = await reader.read()
      if (item.done) break
      outgoing.write(item.value)
    }
  outgoing.end()
}
export async function startControllerUpstream(options: {
  token: string
  overrideToken: string
}) {
  const fixture = await startFixtureUpstream()
  let pendingOAuth = false
  const active = new Set<AbortController>()
  const handler = async (
    incoming: IncomingMessage,
    outgoing: ServerResponse,
  ) => {
    const path = incoming.url ?? "/"
    if (path === "/login/oauth/access_token") {
      await readBody(incoming)
      outgoing.writeHead(200, { "content-type": "application/json" })
      outgoing.end(
        JSON.stringify(
          pendingOAuth ?
            { error: "authorization_pending" }
          : {
              access_token: options.overrideToken,
              token_type: "bearer",
              scope: "read:user",
            },
        ),
      )
      return
    }
    const headers: Record<string, string> = {}
    for (const name of ["authorization", "content-type", "accept"]) {
      const value = incoming.headers[name]
      if (typeof value === "string")
        headers[name] = value.replace(options.overrideToken, options.token)
    }
    const abort = new AbortController()
    active.add(abort)
    outgoing.once("close", () => {
      abort.abort()
      active.delete(abort)
    })
    const response = await fetch(fixture.origin + path, {
      method: incoming.method ?? "GET",
      headers,
      signal: abort.signal,
      ...(incoming.method === "POST" ? { body: await readBody(incoming) } : {}),
    })
    await sendFixtureResponse({
      path,
      response,
      outgoing,
      otherUser:
        incoming.headers.authorization?.includes(options.overrideToken)
        ?? false,
    })
  }
  const server = createServer((incoming, outgoing) => {
    void handler(incoming, outgoing).catch(() => outgoing.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("No upstream port")
  return {
    origin: "http://127.0.0.1:" + String(address.port),
    pendingOAuth: (value: boolean) => {
      pendingOAuth = value
    },
    async close(): Promise<void> {
      for (const abort of active) abort.abort()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
      await fixture.close()
    },
  }
}
