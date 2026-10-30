import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { z } from "zod"

import type { AgentTarget, DesktopModel } from "../shared/contracts"

import { createConnectionSnippet, supportsAgent } from "../shared/connections"

const modelId = 'fixture/model\'s $(printf MODEL_INJECTED) "preview"'
const apiKey = "fixture_key's $(printf KEY_INJECTED) 01234567890123456789"
const model: DesktopModel = {
  id: modelId,
  name: "Fixture model's preview",
  vendor: "local-fixture",
  contextWindow: 200_000,
  maxOutput: 40_000,
  supports: ["tools", "streaming"],
  endpoints: ["/responses", "/chat/completions"],
  preview: false,
}
const posixShell = Bun.which("sh")
const powershell = Bun.which("pwsh") ?? Bun.which("powershell")
const payloadSchema = z.union([
  z
    .object({
      model: z.string(),
      messages: z
        .array(
          z
            .object({
              role: z.literal("user"),
              content: z.string().min(1),
            })
            .strict(),
        )
        .length(1),
    })
    .strict(),
  z.object({ model: z.string(), input: z.string().min(1) }).strict(),
])
const posixStubs = String.raw`
record() { printf '%s\0' "$@"; }
claude() {
  record claude "$ANTHROPIC_BASE_URL" "$ANTHROPIC_AUTH_TOKEN" "$ANTHROPIC_MODEL" \
    "$CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" "$DISABLE_NON_ESSENTIAL_MODEL_CALLS" "$@"
}
codex() { record codex "$COPILOT_BRIDGE_API_KEY" "$@"; }
opencode() { record opencode "$OPENCODE_CONFIG_CONTENT" "$@"; }
curl() { record curl "$@"; }
`

function snippet(target: AgentTarget, selectedModel = model): string {
  return createConnectionSnippet({
    target,
    model: selectedModel,
    port: 43219,
    apiKey,
    shell: "posix",
  })
}

function executePosix(source: string): Array<string> {
  if (!posixShell) throw new Error("A POSIX shell is unavailable")
  const child = spawnSync(
    posixShell,
    ["-eu", "-c", `${posixStubs}\n${source}`],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    },
  )
  expect(child.error).toBeUndefined()
  expect(child.status).toBe(0)
  expect(child.stderr).toBe("")
  expect(child.stdout).toEndWith("\0")
  return child.stdout.split("\0").slice(0, -1)
}

describe.skipIf(!posixShell)("executable POSIX connection snippets", () => {
  test("Claude Code receives the local gateway and literal credentials and model", () => {
    expect(executePosix(snippet("claude-code"))).toEqual([
      "claude",
      "http://127.0.0.1:43219",
      apiKey,
      modelId,
      "1",
      "1",
    ])
  })

  test("Codex receives parsed model and Responses provider overrides as intact arguments", () => {
    const observed = executePosix(snippet("codex"))
    expect(observed.slice(0, 2)).toEqual(["codex", apiKey])
    const args = observed.slice(2)
    const overrides: Array<string> = []
    for (let index = 0; index < args.length; index += 2) {
      expect(args[index]).toBe("-c")
      overrides.push(args[index + 1] ?? "")
    }
    const config: unknown = Bun.TOML.parse(overrides.join("\n"))
    expect(config).toEqual({
      model: modelId,
      model_provider: "copilot_bridge",
      model_providers: {
        copilot_bridge: {
          name: "Copilot Bridge",
          base_url: "http://127.0.0.1:43219/v1",
          env_key: "COPILOT_BRIDGE_API_KEY",
          wire_api: "responses",
        },
      },
      model_context_window: 200_000,
      model_auto_compact_token_limit: 144_000,
    })
  })

  test("OpenCode receives valid provider JSON with the quoted model and private gateway key", () => {
    const [command, config, ...args] = executePosix(snippet("opencode"))
    expect(command).toBe("opencode")
    expect(args).toEqual([])
    const parsed: unknown = JSON.parse(config)
    expect(parsed).toEqual({
      model: `copilot_bridge/${modelId}`,
      provider: {
        copilot_bridge: {
          npm: "@ai-sdk/openai-compatible",
          name: "Copilot Bridge",
          options: { baseURL: "http://127.0.0.1:43219/v1", apiKey },
          models: {
            [modelId]: {
              name: "Fixture model's preview",
              limit: { context: 200_000, output: 40_000 },
            },
          },
        },
      },
    })
  })

  test.each([
    {
      endpoints: ["/chat/completions"],
      endpoint: "chat/completions",
      chat: true,
    },
    { endpoints: ["/responses"], endpoint: "responses", chat: false },
    {
      endpoints: ["/responses", "/chat/completions"],
      endpoint: "chat/completions",
      chat: true,
    },
  ])(
    "HTTP selects $endpoint for $endpoints and sends valid literal JSON",
    (entry) => {
      const observed = executePosix(
        snippet("curl", { ...model, endpoints: [...entry.endpoints] }),
      )
      expect(observed.slice(0, -1)).toEqual([
        "curl",
        `http://127.0.0.1:43219/v1/${entry.endpoint}`,
        "-H",
        `Authorization: Bearer ${apiKey}`,
        "-H",
        "Content-Type: application/json",
        "--data-raw",
      ])
      const body = payloadSchema.parse(JSON.parse(observed.at(-1) ?? ""))
      expect(body.model).toBe(modelId)
      expect("messages" in body).toBe(entry.chat)
    },
  )
})

test.each([
  { target: "codex", endpoints: ["/chat/completions"] },
  { target: "opencode", endpoints: ["/responses"] },
] satisfies Array<{ target: AgentTarget; endpoints: Array<string> }>)(
  "$target rejects incompatible model endpoints $endpoints",
  ({ target, endpoints }) => {
    const incompatible = { ...model, endpoints }
    expect(supportsAgent(incompatible, target)).toBe(false)
    expect(() => snippet(target, incompatible)).toThrow("does not support")
  },
)

test.skipIf(!powershell)(
  "PowerShell executes quoted model and authentication exports when installed",
  () => {
    if (!powershell) throw new Error("PowerShell is unavailable")
    const source = createConnectionSnippet({
      target: "claude-code",
      model,
      port: 43219,
      apiKey,
      shell: "powershell",
    })
    const stub = `function claude {
    $values = @($env:ANTHROPIC_BASE_URL, $env:ANTHROPIC_AUTH_TOKEN, $env:ANTHROPIC_MODEL)
    ConvertTo-Json -Compress -InputObject $values
  }`
    const child = spawnSync(
      powershell,
      ["-NoProfile", "-NonInteractive", "-Command", `${stub}\n${source}`],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH },
      },
    )
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(0)
    expect(child.stderr).toBe("")
    const observed: unknown = JSON.parse(child.stdout)
    expect(observed).toEqual(["http://127.0.0.1:43219", apiKey, modelId])
  },
)
