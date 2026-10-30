import type { AgentTarget, DesktopModel, DesktopSettings } from "./contracts"

export const AGENTS: Array<{
  id: AgentTarget
  name: string
  command: string
  protocol: string
}> = [
  {
    id: "claude-code",
    name: "Claude Code",
    command: "claude",
    protocol: "Anthropic Messages",
  },
  {
    id: "codex",
    name: "Codex",
    command: "codex",
    protocol: "OpenAI Responses",
  },
  {
    id: "opencode",
    name: "OpenCode",
    command: "opencode",
    protocol: "OpenAI Chat Completions",
  },
  { id: "curl", name: "HTTP", command: "curl", protocol: "OpenAI compatible" },
]

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
  model: DesktopModel
  port: number
  apiKey: string
  shell: DesktopSettings["shell"]
}

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

export function createConnectionSnippet(options: ConnectionOptions): string {
  const { target, model, port, apiKey, shell } = options
  if (!supportsAgent(model, target)) {
    throw new Error(
      "This model does not support this agent's API. Choose another model.",
    )
  }
  const rootUrl = `http://127.0.0.1:${port}`
  const baseUrl = `${rootUrl}/v1`

  switch (target) {
    case "claude-code": {
      return [
        environment("ANTHROPIC_BASE_URL", rootUrl, shell),
        environment("ANTHROPIC_AUTH_TOKEN", apiKey, shell),
        environment("ANTHROPIC_MODEL", model.id, shell),
        environment("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1", shell),
        environment("DISABLE_NON_ESSENTIAL_MODEL_CALLS", "1", shell),
        "",
        "claude",
      ].join("\n")
    }
    case "codex": {
      const settings = [
        `model=${JSON.stringify(model.id)}`,
        'model_provider="copilot_bridge"',
        'model_providers.copilot_bridge.name="Copilot Bridge"',
        `model_providers.copilot_bridge.base_url=${JSON.stringify(baseUrl)}`,
        'model_providers.copilot_bridge.env_key="COPILOT_BRIDGE_API_KEY"',
        'model_providers.copilot_bridge.wire_api="responses"',
      ]
      if (model.contextWindow) {
        settings.push(
          `model_context_window=${model.contextWindow}`,
          `model_auto_compact_token_limit=${Math.floor((model.contextWindow - (model.maxOutput ?? 0)) * 0.9)}`,
        )
      }
      return [
        environment("COPILOT_BRIDGE_API_KEY", apiKey, shell),
        "",
        `codex ${settings.map((setting) => `-c ${quote(setting, shell)}`).join(" ")}`,
      ].join("\n")
    }
    case "opencode": {
      const config = {
        model: `copilot_bridge/${model.id}`,
        provider: {
          copilot_bridge: {
            npm: "@ai-sdk/openai-compatible",
            name: "Copilot Bridge",
            options: { baseURL: baseUrl, apiKey },
            models: {
              [model.id]: {
                name: model.name,
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
      }
      return [
        environment("OPENCODE_CONFIG_CONTENT", JSON.stringify(config), shell),
        "",
        "opencode",
      ].join("\n")
    }
    case "curl": {
      const usesChat = model.endpoints.includes("/chat/completions")
      const endpoint = `${baseUrl}/${usesChat ? "chat/completions" : "responses"}`
      const input = "Reply with exactly: Copilot Bridge is connected."
      const payload = JSON.stringify(
        usesChat ?
          { model: model.id, messages: [{ role: "user", content: input }] }
        : { model: model.id, input },
      )
      if (shell === "powershell") {
        return [
          `Invoke-RestMethod -Uri ${quote(endpoint, shell)} -Method Post`,
          `  -Headers @{ Authorization = ${quote(`Bearer ${apiKey}`, shell)} }`,
          `  -ContentType 'application/json' -Body ${quote(payload, shell)}`,
        ].join(" `\n")
      }
      return [
        `curl ${quote(endpoint, shell)}`,
        `  -H ${quote(`Authorization: Bearer ${apiKey}`, shell)}`,
        "  -H 'Content-Type: application/json'",
        `  --data-raw ${quote(payload, shell)}`,
      ].join(" \\\n")
    }
    default: {
      return target satisfies never
    }
  }
}
