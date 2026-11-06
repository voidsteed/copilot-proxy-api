import type { NativeConnection } from "../../src/lib/proxy-contracts"
import type {
  AgentConfigView,
  AgentTarget,
  DesktopModel,
  DesktopSettings,
  PublicConnection,
} from "./contracts"

import { agentTargetSchema } from "./contracts"

export const AGENT_DETAILS = {
  "claude-code": {
    name: "Claude Code",
    command: "claude",
    protocol: "Anthropic Messages",
  },
  codex: { name: "Codex", command: "codex", protocol: "OpenAI Responses" },
  opencode: {
    name: "OpenCode",
    command: "opencode",
    protocol: "OpenAI Chat Completions",
  },
  curl: { name: "HTTP", command: "curl", protocol: "OpenAI compatible" },
} satisfies Record<
  AgentTarget,
  { name: string; command: string; protocol: string }
>

export const AGENTS = agentTargetSchema.options.map((id) => ({
  id,
  ...AGENT_DETAILS[id],
}))

export function supportsAgent(
  model: DesktopModel,
  target: AgentTarget,
): boolean {
  if (target === "codex") return model.endpoints.includes("/responses")
  if (target === "opencode")
    return model.endpoints.includes("/chat/completions")
  return model.endpoints.some(
    (endpoint) => endpoint === "/responses" || endpoint === "/chat/completions",
  )
}

interface ConnectionOptions {
  target: AgentTarget
  shell: DesktopSettings["shell"]
  connection: NativeConnection
  model: DesktopModel
  modelId?: string
  agentConfig?: AgentConfigView
}
type SnippetOptions = ConnectionOptions & { selectedModelId: string }

function quote(value: string, shell: DesktopSettings["shell"]): string {
  const escaped = value.replaceAll(
    "'",
    shell === "posix" ? String.raw`'\''` : "''",
  )
  return `'${escaped}'`
}

function environment(
  name: string,
  value: string,
  shell: DesktopSettings["shell"],
): string {
  return shell === "powershell" ?
      `$env:${name} = ${quote(value, shell)}`
    : `export ${name}=${quote(value, shell)}`
}

function endpointMatches(value: string | null, expected: string): boolean {
  if (value === null) return false
  try {
    const actual = new URL(value)
    const current = new URL(expected)
    const loopback = new Set(["localhost", "127.0.0.1", "[::1]"])
    const sameHost =
      actual.hostname === current.hostname
      || (loopback.has(actual.hostname) && loopback.has(current.hostname))
    return (
      sameHost
      && actual.protocol === current.protocol
      && actual.port === current.port
      && actual.pathname.replace(/\/+$/u, "")
        === current.pathname.replace(/\/+$/u, "")
      && !actual.username
      && !actual.password
      && !actual.search
      && !actual.hash
    )
  } catch {
    return false
  }
}

function checkAgentConnection(options: ConnectionOptions): void {
  const config = options.agentConfig
  if (!config) return
  if (
    config.target !== options.target
    || config.status === "conflicting"
    || config.status === "invalid"
  )
    throw new Error(
      "Review this agent's existing configuration before connecting.",
    )
  const saved = config.target === "claude-code" ? config.rootUrl : config.apiUrl
  const expected =
    config.target === "claude-code" ?
      options.connection.rootUrl
    : options.connection.apiUrl
  if (
    (saved !== null || config.status === "configured")
    && !endpointMatches(saved, expected)
  )
    throw new Error(
      "This agent's existing proxy URL does not match the running proxy. Open its configuration to review it.",
    )
}

function claudeSnippet(options: SnippetOptions): string {
  const { connection, selectedModelId, shell, agentConfig } = options
  const lines = [
    environment(
      "ANTHROPIC_BASE_URL",
      agentConfig?.rootUrl ?? connection.rootUrl,
      shell,
    ),
    environment("ANTHROPIC_MODEL", selectedModelId, shell),
  ]
  if (connection.authentication.kind === "keyed")
    lines.push(
      environment("ANTHROPIC_AUTH_TOKEN", connection.authentication.key, shell),
    )
  else if (!agentConfig?.authenticationPresent)
    lines.push(environment("ANTHROPIC_AUTH_TOKEN", "dummy", shell))
  if (!agentConfig)
    lines.push(
      environment("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1", shell),
      environment("DISABLE_NON_ESSENTIAL_MODEL_CALLS", "1", shell),
    )
  return [...lines, "", "claude"].join("\n")
}

function codexSnippet(options: SnippetOptions): string {
  const { connection, selectedModelId, model, shell, agentConfig } = options
  const settings = [
    `model=${JSON.stringify(selectedModelId)}`,
    'model_provider="copilot_proxy"',
    'model_providers.copilot_proxy.name="Copilot Proxy"',
    `model_providers.copilot_proxy.base_url=${JSON.stringify(agentConfig?.apiUrl ?? connection.apiUrl)}`,
    'model_providers.copilot_proxy.wire_api="responses"',
  ]
  const lines: Array<string> = []
  if (connection.authentication.kind === "keyed") {
    lines.push(
      environment(
        "COPILOT_PROXY_API_KEY",
        connection.authentication.key,
        shell,
      ),
      "",
    )
    settings.push(
      'model_providers.copilot_proxy.env_key="COPILOT_PROXY_API_KEY"',
    )
  }
  if (!agentConfig && model.contextWindow)
    settings.push(
      `model_context_window=${model.contextWindow}`,
      `model_auto_compact_token_limit=${Math.floor((model.contextWindow - (model.maxOutput ?? 0)) * 0.9)}`,
    )
  lines.push(
    `codex ${settings.map((setting) => `-c ${quote(setting, shell)}`).join(" ")}`,
  )
  return lines.join("\n")
}

function opencodeSnippet(options: SnippetOptions): string {
  const { connection, selectedModelId, model, shell, agentConfig } = options
  const configured = agentConfig?.model.kind === "configured"
  const separator = selectedModelId.indexOf("/")
  const provider =
    configured && separator > 0 ?
      selectedModelId.slice(0, separator)
    : "copilot_proxy"
  const modelId =
    configured && separator > 0 ?
      selectedModelId.slice(separator + 1)
    : selectedModelId
  const config = {
    model: configured ? selectedModelId : `${provider}/${modelId}`,
    provider: {
      [provider]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Copilot Proxy",
        options: {
          baseURL: agentConfig?.apiUrl ?? connection.apiUrl,
          ...(connection.authentication.kind === "keyed" ?
            { apiKey: connection.authentication.key }
          : {}),
        },
        models: {
          [modelId]: {
            name: model.name,
            ...(!agentConfig && model.contextWindow && model.maxOutput ?
              {
                limit: {
                  context: model.contextWindow,
                  output: model.maxOutput,
                },
              }
            : {}),
          },
        },
      },
    },
  }
  return [
    environment("OPENCODE_CONFIG_CONTENT", JSON.stringify(config), shell),
    "",
    "opencode",
  ].join("\n")
}

export function createHttpRequest(options: {
  connection: PublicConnection
  model: DesktopModel
  modelId?: string
}) {
  const { model, connection } = options
  const modelId = options.modelId ?? model.id
  const chat = model.endpoints.includes("/chat/completions")
  const input = "Reply with exactly: Copilot Proxy is connected."
  const payload =
    chat ?
      { model: modelId, messages: [{ role: "user", content: input }] }
    : { model: modelId, input }
  const endpoint = chat ? "chat/completions" : "responses"
  return {
    url: `${connection.apiUrl.replace(/\/+$/u, "")}/${endpoint}`,
    payload,
  }
}

function httpSnippet(options: SnippetOptions): string {
  const { connection, selectedModelId, shell } = options
  const request = createHttpRequest({
    connection,
    model: options.model,
    modelId: selectedModelId,
  })
  const payload = JSON.stringify(request.payload)
  if (shell === "powershell") {
    const lines = [
      `Invoke-RestMethod -Uri ${quote(request.url, shell)} -Method Post`,
    ]
    if (connection.authentication.kind === "keyed")
      lines.push(
        `  -Headers @{ Authorization = ${quote(`Bearer ${connection.authentication.key}`, shell)} }`,
      )
    lines.push(
      `  -ContentType 'application/json' -Body ${quote(payload, shell)}`,
    )
    return lines.join(" `\n")
  }
  const lines = [`curl ${quote(request.url, shell)}`]
  if (connection.authentication.kind === "keyed")
    lines.push(
      `  -H ${quote(`Authorization: Bearer ${connection.authentication.key}`, shell)}`,
    )
  lines.push(
    "  -H 'Content-Type: application/json'",
    `  --data-raw ${quote(payload, shell)}`,
  )
  return lines.join(" \\\n")
}

export function createConnectionSnippet(options: ConnectionOptions): string {
  checkAgentConnection(options)
  if (options.agentConfig?.status === "configured")
    return AGENT_DETAILS[options.target].command
  if (!supportsAgent(options.model, options.target))
    throw new Error(
      "This model does not support this agent's API. Choose another model.",
    )
  const selectedModelId =
    options.agentConfig?.model.kind === "configured" ?
      options.agentConfig.model.exact
    : (options.modelId ?? options.model.id)
  const context = { ...options, selectedModelId }
  const snippets = {
    "claude-code": claudeSnippet,
    codex: codexSnippet,
    opencode: opencodeSnippet,
    curl: httpSnippet,
  }
  return snippets[options.target](context)
}
