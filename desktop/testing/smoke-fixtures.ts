import { parse as parseJsonc } from "jsonc-parser"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { parse as parseToml } from "smol-toml"
import { z } from "zod"

import type { ConfigurableAgent } from "../../src/lib/proxy-contracts"

import { nativeConnectionSchema } from "../../src/lib/proxy-contracts"

interface AgentFileFixture {
  target: ConfigurableAgent
  path: string
  original: string
  comments: Array<string>
  parse(value: string): unknown
  permissions: number
  location: { kind: "regular" } | { kind: "symlink"; destination: string }
}

const claude = `{
  // Preserve the exact model alias and the operator's permissions.
  "env": {
    "ANTHROPIC_MODEL": "fixture-claude-sonnet[1m]",
    "ANTHROPIC_SMALL_FAST_MODEL": "operator-small-model"
  },
  "permissions": { "allow": ["Bash(git status:*)"], "deny": [] },
  "hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": "echo fixture-ready" }] }] }
}
`
const codex = `# Preserve the independent Codex model and its MCP server.
model = "fixture-responses-only"
model_provider = "copilot_proxy"
approval_policy = "never"

[features]
multi_agent = true

[model_providers.copilot_proxy]
name = "Operator's proxy label"
wire_api = "responses"

[mcp_servers.local]
command = "fixture-mcp"
args = ["--preserve", "me"]
`
const opencode = `{
  // Preserve this symlink, permission policy, and MCP server.
  "$schema": "https://opencode.ai/config.json",
  "permission": { "edit": "ask", "bash": "ask" },
  "mcp": { "local": { "type": "local", "command": ["fixture-mcp"], "enabled": true } },
  "small_model": "operator/small-model"
}
`

function jsonDocument(value: string): unknown {
  const parsed: unknown = parseJsonc(value)
  return z.json().parse(parsed)
}

export async function seedNativeAgentFiles(
  homeDirectory: string,
): Promise<Array<AgentFileFixture>> {
  const seeds: Array<Omit<AgentFileFixture, "permissions" | "location">> = [
    {
      target: "claude-code",
      path: path.join(homeDirectory, ".claude", "settings.json"),
      original: claude,
      comments: ["// Preserve the exact model alias"],
      parse: jsonDocument,
    },
    {
      target: "codex",
      path: path.join(homeDirectory, ".codex", "config.toml"),
      original: codex,
      comments: ["# Preserve the independent Codex model"],
      parse: parseToml,
    },
    {
      target: "opencode",
      path: path.join(homeDirectory, ".config", "opencode", "opencode.jsonc"),
      original: opencode,
      comments: ["// Preserve this symlink"],
      parse: jsonDocument,
    },
  ]
  const files: Array<AgentFileFixture> = []
  for (const file of seeds) {
    await fs.mkdir(path.dirname(file.path), { recursive: true })
    let location: AgentFileFixture["location"] = { kind: "regular" }
    if (file.target === "opencode" && process.platform !== "win32") {
      const destination = path.join(path.dirname(file.path), "operator.jsonc")
      await fs.writeFile(destination, file.original, {
        flag: "wx",
        mode: 0o640,
      })
      await fs.symlink(destination, file.path)
      location = { kind: "symlink", destination }
    } else {
      await fs.writeFile(file.path, file.original, { flag: "wx", mode: 0o640 })
    }
    files.push({
      ...file,
      permissions: (await fs.stat(file.path)).mode & 0o777,
      location,
    })
  }
  return files
}

function assertExistingValues(original: unknown, configured: unknown): void {
  if (
    typeof original !== "object"
    || original === null
    || Array.isArray(original)
  ) {
    assert.deepEqual(configured, original)
    return
  }
  assert(
    typeof configured === "object"
      && configured !== null
      && !Array.isArray(configured),
  )
  for (const [key, value] of Object.entries(original)) {
    assert(key in configured, `The existing field ${key} survives Configure`)
    assertExistingValues(value, Reflect.get(configured, key))
  }
}

export async function verifyNativeAgentFile(
  file: AgentFileFixture,
): Promise<string> {
  const configured = await fs.readFile(file.path, "utf8")
  assertExistingValues(file.parse(file.original), file.parse(configured))
  for (const comment of file.comments) assert(configured.includes(comment))
  assert.equal((await fs.stat(file.path)).mode & 0o777, file.permissions)
  if (file.location.kind === "symlink") {
    assert((await fs.lstat(file.path)).isSymbolicLink())
    assert.equal(await fs.readlink(file.path), file.location.destination)
  }
  return configured
}

const legacyModels = [
  {
    id: "fixture-legacy-claude",
    object: "model",
    display_name: "Legacy Claude fixture",
    owned_by: "Anthropic",
    supported_endpoints: ["/chat/completions"],
    capabilities: {
      family: "claude",
      type: "chat",
      limits: { max_context_window_tokens: 200_000, max_output_tokens: 32_000 },
      supports: { tool_calls: true, streaming: true, vision: true },
    },
  },
  {
    id: "fixture-legacy-responses",
    object: "model",
    display_name: "Legacy Responses fixture",
    owned_by: "OpenAI",
    supported_endpoints: ["/responses"],
    capabilities: {
      family: "responses",
      type: "chat",
      limits: { max_context_window_tokens: 256_000, max_output_tokens: 64_000 },
      supports: { tool_calls: true, streaming: true, vision: false },
    },
  },
]

const legacyUsage = {
  copilot_plan: "individual",
  quota_reset_date: "2026-11-01",
  quota_snapshots: {
    chat: { unlimited: true },
    premium_interactions: {
      unlimited: false,
      entitlement: 100,
      remaining: 75,
      percent_remaining: 75,
    },
  },
}

export async function startSmokeLegacyProxy() {
  const history: Array<{
    id: string
    method: string
    path: string
    status: number
    startedAt: string
    durationMs: number
  }> = []
  const methods: Array<string> = []
  let requestId = 0
  const server = createServer((request, response) => {
    const method = request.method ?? "GET"
    const endpoint = request.url ?? "/"
    const started = performance.now()
    const startedAt = new Date().toISOString()
    methods.push(method)
    request.resume()
    if (endpoint === "/") {
      response.end("Server running")
      return
    }
    response.setHeader("content-type", "application/json")
    let reply: unknown
    switch (endpoint) {
      case "/models":
      case "/v1/models": {
        reply = { object: "list", data: legacyModels }
        break
      }
      case "/usage": {
        reply = legacyUsage
        break
      }
      case "/debug/requests": {
        reply = { object: "list", data: history }
        break
      }
      default: {
        if (
          method === "POST"
          && ["/v1/chat/completions", "/v1/responses"].includes(endpoint)
        ) {
          const id = ++requestId
          response.once("finish", () => {
            history.push({
              id: `legacy-inference-${id}`,
              method,
              path: endpoint,
              status: response.statusCode,
              startedAt,
              durationMs: performance.now() - started,
            })
          })
          reply = {
            id: `fixture-${id}`,
            output_text: "Legacy Copilot Proxy is connected.",
            choices: [
              { message: { content: "Legacy Copilot Proxy is connected." } },
            ],
          }
        } else {
          response.statusCode = 404
          reply = { error: "No legacy control endpoint exists." }
        }
      }
    }
    response.end(JSON.stringify(reply))
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert(address && typeof address !== "string")
  const rootUrl = `http://127.0.0.1:${address.port}`
  return {
    connection: nativeConnectionSchema.parse({
      rootUrl,
      apiUrl: `${rootUrl}/v1`,
      authentication: { kind: "none" },
    }),
    methods,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      })
    },
  }
}
