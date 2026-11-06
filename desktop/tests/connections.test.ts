import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { z } from "zod"

import type {
  AgentConfigView,
  AgentTarget,
  ConfigurableAgent,
  DesktopModel,
} from "../shared/contracts"

import { nativeConnectionSchema } from "../../src/lib/proxy-contracts"
import { createConnectionSnippet, supportsAgent } from "../shared/connections"

const modelId = 'fixture/model\'s $(printf MODEL_INJECTED) "preview"'
const apiKey = "fixture_key's $(printf KEY_INJECTED) 01234567890123456789"
const connection = nativeConnectionSchema.parse({
  rootUrl: "http://localhost:43219",
  apiUrl: "http://localhost:43219/v1",
  authentication: { kind: "keyed", key: apiKey },
})
const unkeyedConnection = nativeConnectionSchema.parse({
  ...connection,
  authentication: { kind: "none" },
})
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
COPILOT_PROXY_API_KEY=''
ANTHROPIC_BASE_URL=''
ANTHROPIC_AUTH_TOKEN=''
ANTHROPIC_MODEL=''
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=''
DISABLE_NON_ESSENTIAL_MODEL_CALLS=''
OPENCODE_CONFIG_CONTENT=''
record() { printf '%s\0' "$@"; }
claude() {
  record claude "$ANTHROPIC_BASE_URL" "$ANTHROPIC_AUTH_TOKEN" "$ANTHROPIC_MODEL" \
    "$CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" "$DISABLE_NON_ESSENTIAL_MODEL_CALLS" "$@"
}
codex() { record codex "$COPILOT_PROXY_API_KEY" "$@"; }
opencode() { record opencode "$OPENCODE_CONFIG_CONTENT" "$@"; }
curl() { record curl "$@"; }
`

function snippet(target: AgentTarget, selectedModel = model): string {
  return createConnectionSnippet({
    target,
    model: selectedModel,
    connection,
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
      "http://localhost:43219",
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
      model_provider: "copilot_proxy",
      model_providers: {
        copilot_proxy: {
          name: "Copilot Proxy",
          base_url: "http://localhost:43219/v1",
          env_key: "COPILOT_PROXY_API_KEY",
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
      model: `copilot_proxy/${modelId}`,
      provider: {
        copilot_proxy: {
          npm: "@ai-sdk/openai-compatible",
          name: "Copilot Proxy",
          options: { baseURL: "http://localhost:43219/v1", apiKey },
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
        `http://localhost:43219/v1/${entry.endpoint}`,
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
      connection,
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
    expect(observed).toEqual(["http://localhost:43219", apiKey, modelId])
  },
)

function savedConfig(target: ConfigurableAgent): AgentConfigView {
  return {
    target,
    path: `/fixture/${target}/config`,
    status: "configured",
    model: {
      kind: "configured",
      exact:
        target === "claude-code" ? "claude-sonnet-5.5[1m]" : "operator-model",
      catalogId: null,
    },
    rootUrl:
      target === "claude-code" ?
        "http://localhost:43219/"
      : "http://localhost:43219",
    apiUrl: target === "claude-code" ? null : "http://localhost:43219/v1/",
    authenticationPresent: true,
    missingFields: [],
    conflictFields: [],
  }
}

test.each([
  { target: "claude-code", command: "claude" },
  { target: "codex", command: "codex" },
  { target: "opencode", command: "opencode" },
] satisfies Array<{ target: ConfigurableAgent; command: string }>)(
  "$target uses its existing configuration even when its catalog entry is unknown",
  ({ target, command }) => {
    expect(
      createConnectionSnippet({
        target,
        connection,
        shell: "posix",
        model: { ...model, endpoints: [] },
        agentConfig: savedConfig(target),
      }),
    ).toBe(command)
  },
)

test("refuses to override an existing configuration that points at another proxy", () => {
  const agentConfig = {
    ...savedConfig("claude-code"),
    rootUrl: "http://localhost:4142",
  }
  expect(() =>
    createConnectionSnippet({
      target: "claude-code",
      connection,
      shell: "posix",
      model,
      agentConfig,
    }),
  ).toThrow("does not match")
})

test.each(["conflicting", "invalid"] satisfies Array<
  AgentConfigView["status"]
>)(
  "refuses a $1 configuration instead of generating synthetic overrides",
  (status) => {
    expect(() =>
      createConnectionSnippet({
        target: "codex",
        connection,
        shell: "posix",
        model,
        agentConfig: { ...savedConfig("codex"), status },
      }),
    ).toThrow("existing configuration")
  },
)

test("keeps a saved Claude model alias when generating missing connection settings", () => {
  const agentConfig: AgentConfigView = {
    ...savedConfig("claude-code"),
    status: "missing",
    rootUrl: null,
    missingFields: ["env.ANTHROPIC_BASE_URL"],
  }
  const source = createConnectionSnippet({
    target: "claude-code",
    connection,
    shell: "posix",
    model,
    modelId: "another-model",
    agentConfig,
  })
  expect(executePosix(source).slice(0, 4)).toEqual([
    "claude",
    connection.rootUrl,
    apiKey,
    "claude-sonnet-5.5[1m]",
  ])
})

describe.skipIf(!posixShell)("unkeyed proxy snippets", () => {
  test("Codex receives no invented environment key or auth requirement", () => {
    const source = createConnectionSnippet({
      target: "codex",
      connection: unkeyedConnection,
      shell: "posix",
      model,
    })
    expect(source).not.toContain("env_key")
    expect(source).not.toContain("export COPILOT_PROXY_API_KEY")
    expect(executePosix(source).slice(0, 2)).toEqual(["codex", ""])
  })

  test("OpenCode receives the current API URL without a fabricated key", () => {
    const source = createConnectionSnippet({
      target: "opencode",
      connection: unkeyedConnection,
      shell: "posix",
      model,
    })
    const observed = executePosix(source)
    const config: unknown = JSON.parse(observed[1] ?? "")
    expect(config).toMatchObject({
      provider: {
        copilot_proxy: { options: { baseURL: unkeyedConnection.apiUrl } },
      },
    })
    expect(JSON.stringify(config)).not.toContain("apiKey")
  })

  test("HTTP uses the current endpoint and sends no unnecessary auth header", () => {
    const source = createConnectionSnippet({
      target: "curl",
      connection: unkeyedConnection,
      shell: "posix",
      model,
    })
    const observed = executePosix(source)
    expect(observed.slice(0, -1)).toEqual([
      "curl",
      `${unkeyedConnection.apiUrl}/chat/completions`,
      "-H",
      "Content-Type: application/json",
      "--data-raw",
    ])
    expect(source).not.toContain("Authorization")
    expect(payloadSchema.parse(JSON.parse(observed.at(-1) ?? "")).model).toBe(
      modelId,
    )
  })
})
