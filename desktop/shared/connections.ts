import type {
  ConfigurableAgent,
  NativeConnection,
} from "../../src/lib/proxy-contracts"
import type {
  AgentConfigView,
  AgentTarget,
  DesktopModel,
  DesktopSettings,
  LaunchConfiguredAgent,
  PublicConnection,
} from "./contracts"

import { agentTargetSchema, isGoogleChatModel } from "./contracts"

export type AgentMode = "file-configured" | "launch-configured" | "http"
export type AgentEndpointKind = "root" | "origin" | "api"

export const AGENT_DETAILS = {
  "claude-code": {
    name: "Claude Code",
    command: "claude",
    protocol: "Anthropic Messages",
    mode: "file-configured",
    endpointKind: "root",
  },
  codex: {
    name: "Codex",
    command: "codex",
    protocol: "OpenAI Responses",
    mode: "file-configured",
    endpointKind: "api",
  },
  opencode: {
    name: "OpenCode",
    command: "opencode",
    protocol: "OpenAI Chat Completions",
    mode: "file-configured",
    endpointKind: "api",
  },
  antigravity: {
    name: "Antigravity CLI",
    command: "agy",
    protocol: "Gemini API",
    mode: "launch-configured",
    endpointKind: "origin",
  },
  curl: {
    name: "HTTP",
    command: "curl",
    protocol: "OpenAI compatible",
    mode: "http",
    endpointKind: "api",
  },
} satisfies Record<
  AgentTarget,
  {
    name: string
    command: string
    protocol: string
    mode: AgentMode
    endpointKind: AgentEndpointKind
  }
>

export const AGENTS = agentTargetSchema.options.map((id) => ({
  id,
  ...AGENT_DETAILS[id],
}))

export function connectionOrigin(
  connection: Pick<PublicConnection, "rootUrl">,
): string {
  return connection.rootUrl.replace(/\/+$/u, "")
}

export function connectionUrlForAgent(
  connection: Pick<PublicConnection, "rootUrl" | "apiUrl">,
  target: AgentTarget,
): string {
  const kind = AGENT_DETAILS[target].endpointKind
  switch (kind) {
    case "root": {
      return connection.rootUrl
    }
    case "origin": {
      return connectionOrigin(connection)
    }
    case "api": {
      return connection.apiUrl
    }
    default: {
      const exhaustive: never = kind
      return exhaustive
    }
  }
}

export function supportsAgent(
  model: DesktopModel,
  target: AgentTarget,
): boolean {
  switch (target) {
    case "antigravity": {
      return isGoogleChatModel(model)
    }
    case "codex": {
      return model.endpoints.includes("/responses")
    }
    case "opencode": {
      return model.endpoints.includes("/chat/completions")
    }
    case "claude-code":
    case "curl": {
      return model.endpoints.some(
        (endpoint) =>
          endpoint === "/responses" || endpoint === "/chat/completions",
      )
    }
    default: {
      const exhaustive: never = target
      return exhaustive
    }
  }
}

export function selectLaunchModel(
  models: ReadonlyArray<DesktopModel>,
  target: LaunchConfiguredAgent,
  savedModelId: string | null,
): DesktopModel | null {
  const compatible = models.filter((model) => supportsAgent(model, target))
  return (
    compatible.find((model) => model.id === savedModelId)
    ?? compatible.find((model) => model.id === "gemini-4-neon")
    ?? compatible.find((model) => !model.preview)
    ?? compatible.at(0)
    ?? null
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
  const saved =
    AGENT_DETAILS[config.target].endpointKind === "root" ?
      config.rootUrl
    : config.apiUrl
  const expected = connectionUrlForAgent(options.connection, config.target)
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
  if (!agentConfig && model.contextWindow) {
    settings.push(`model_context_window=${model.contextWindow}`)
    const maxOutput = model.maxOutput ?? 0
    if (model.contextWindow > maxOutput) {
      const compactLimit = Math.floor((model.contextWindow - maxOutput) * 0.9)
      if (compactLimit > 0)
        settings.push(`model_auto_compact_token_limit=${compactLimit}`)
    }
  }
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

const powershellAgySettings = String.raw`$agySettings = if (($PSVersionTable.PSVersion.Major -gt 7 -or ($PSVersionTable.PSVersion.Major -eq 7 -and $PSVersionTable.PSVersion.Minor -ge 3)) -and $PSNativeCommandArgumentPassing -ne 'Legacy' -and (Get-Command agy -ErrorAction SilentlyContinue).Source -notmatch '\.(cmd|bat)$') { '{"modelProvider":"gemini"}' } else { '{\"modelProvider\":\"gemini\"}' }`

function renderAntigravityCommand(options: {
  origin: string
  apiKey: string
  modelId: string
  shell: DesktopSettings["shell"]
}): string {
  const { origin, apiKey, modelId, shell } = options
  const lines = [
    environment("GOOGLE_GEMINI_BASE_URL", origin, shell),
    environment("GEMINI_API_KEY", apiKey, shell),
  ]
  if (shell === "powershell") {
    lines.push(
      powershellAgySettings,
      "",
      `agy --settings $agySettings --model ${quote(modelId, shell)}`,
    )
    return lines.join("\n")
  }
  lines.push(
    "",
    `agy --settings '{"modelProvider":"gemini"}' --model ${quote(modelId, shell)}`,
  )
  return lines.join("\n")
}

function antigravitySnippet(options: SnippetOptions): string {
  return renderAntigravityCommand({
    origin: connectionOrigin(options.connection),
    apiKey:
      options.connection.authentication.kind === "keyed" ?
        options.connection.authentication.key
      : "local-proxy",
    modelId: options.selectedModelId,
    shell: options.shell,
  })
}

export function createLaunchPreview(options: {
  target: LaunchConfiguredAgent
  connection: PublicConnection
  model: DesktopModel
  modelId?: string
  shell: DesktopSettings["shell"]
}): string {
  if (!supportsAgent(options.model, options.target))
    throw new Error(
      "This model does not support this agent's API. Choose another model.",
    )
  return renderAntigravityCommand({
    origin: connectionOrigin(options.connection),
    apiKey:
      options.connection.authentication.kind === "keyed" ?
        "<LOCAL_API_KEY>"
      : "local-proxy",
    modelId: options.modelId ?? options.model.id,
    shell: options.shell,
  })
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

export function createConfigFileSnippet(options: {
  target: ConfigurableAgent
  connection: NativeConnection
  model: DesktopModel
  modelId?: string
}): string {
  const { target, connection, model } = options
  const selectedModelId = options.modelId ?? model.id
  switch (target) {
    case "claude-code": {
      const token =
        connection.authentication.kind === "keyed" ?
          connection.authentication.key
        : "dummy"
      return JSON.stringify(
        {
          env: {
            ANTHROPIC_BASE_URL: connection.rootUrl,
            ANTHROPIC_MODEL: selectedModelId,
            ANTHROPIC_AUTH_TOKEN: token,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
          },
        },
        null,
        2,
      )
    }
    case "codex": {
      const lines = [
        `model = ${JSON.stringify(selectedModelId)}`,
        'model_provider = "copilot_proxy"',
        "",
        "[model_providers.copilot_proxy]",
        'name = "Copilot Proxy"',
        `base_url = ${JSON.stringify(connection.apiUrl)}`,
        'wire_api = "responses"',
      ]
      if (connection.authentication.kind === "keyed") {
        lines.push(
          `experimental_bearer_token = ${JSON.stringify(connection.authentication.key)}`,
        )
      }
      return lines.join("\n")
    }
    case "opencode": {
      const separator = selectedModelId.indexOf("/")
      const provider =
        separator > 0 ? selectedModelId.slice(0, separator) : "copilot_proxy"
      const modelId =
        separator > 0 ? selectedModelId.slice(separator + 1) : selectedModelId
      return JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          model: `${provider}/${modelId}`,
          provider: {
            [provider]: {
              npm: "@ai-sdk/openai-compatible",
              name: "Copilot Proxy",
              options: {
                baseURL: connection.apiUrl,
                ...(connection.authentication.kind === "keyed" ?
                  { apiKey: connection.authentication.key }
                : {}),
              },
              models: {
                [modelId]: {
                  name: model.name || modelId,
                  ...(model.contextWindow && model.maxOutput ?
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
        },
        null,
        2,
      )
    }
    default: {
      const exhaustive: never = target
      return exhaustive
    }
  }
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
    antigravity: antigravitySnippet,
    curl: httpSnippet,
  }
  return snippets[options.target](context)
}
