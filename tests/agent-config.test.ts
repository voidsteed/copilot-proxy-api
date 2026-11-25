import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { parse as parseJsonc } from "jsonc-parser"
import { spawn } from "node:child_process"
import { once } from "node:events"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { parse as parseToml } from "smol-toml"
import { z } from "zod"

import type { CatalogModel, ConfigurableAgent } from "~/lib/proxy-contracts"

import {
  configuredProxyRoots,
  configuredProxyConnections,
  configureMissingAgent,
  getAgentConfigFolder,
  inspectAgentConfigs,
} from "~/lib/agent-config"
import {
  agentModelChoicesSchema,
  modelSchema,
  nativeConnectionSchema,
} from "~/lib/proxy-contracts"

const connection = nativeConnectionSchema.parse({
  rootUrl: "http://localhost:4141",
  apiUrl: "http://localhost:4141/v1",
  authentication: { kind: "none" },
})
const keyedConnection = nativeConnectionSchema.parse({
  ...connection,
  authentication: { kind: "keyed", key: "fixture-local-api-key" },
})
const catalog: Array<CatalogModel> = [
  {
    id: "claude-sonnet-5.5",
    name: "Claude Sonnet 5.5",
    vendor: "Anthropic",
    contextWindow: 200_000,
    maxOutput: 64_000,
    supports: ["tools", "streaming"],
    endpoints: ["/chat/completions", "/responses"],
    preview: false,
  },
  {
    id: "gpt-6.1-sol",
    name: "GPT 6.1 Sol",
    vendor: "OpenAI",
    contextWindow: 400_000,
    maxOutput: 32_000,
    supports: ["tools", "reasoning", "streaming"],
    endpoints: ["/responses", "/chat/completions"],
    preview: false,
  },
]
const proposals = {
  "claude-code": "claude-sonnet-5.5",
  codex: "gpt-6.1-sol",
  opencode: "claude-sonnet-5.5",
}

let homeDirectory: string

beforeEach(async () => {
  homeDirectory = await mkdtemp(join(tmpdir(), "copilot-agent-config-"))
})

afterEach(async () => {
  await rm(homeDirectory, { recursive: true, force: true })
})

function configPath(target: ConfigurableAgent): string {
  const folder = getAgentConfigFolder(target, homeDirectory)
  if (target === "codex") return join(folder, "config.toml")
  if (target === "opencode") return join(folder, "opencode.jsonc")
  return join(folder, "settings.json")
}

async function seed(target: ConfigurableAgent, text: string): Promise<string> {
  const path = configPath(target)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
  return path
}

function inspect() {
  return inspectAgentConfigs({ homeDirectory, connection, catalog, proposals })
}

function jsonDocument(text: string): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(parseJsonc(text))
}

function configure(target: ConfigurableAgent, keyed = false) {
  return configureMissingAgent({
    homeDirectory,
    target,
    connection: keyed ? keyedConnection : connection,
    catalog,
    proposal: { kind: "proposed", catalogId: proposals[target] },
  })
}

const existingClaude = `{
  // Keep the user's hooks and permissions.
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4141/",
    "ANTHROPIC_MODEL": "claude-sonnet-5.5[1m]",
    "ANTHROPIC_SMALL_FAST_MODEL": "claude-sonnet-5",
    "ANTHROPIC_AUTH_TOKEN": "fixture-existing-claude-auth"
  },
  "permissions": { "allow": ["Bash(git status:*)"], "deny": [] },
  "hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": "echo ready" }] }] }
}
`
const existingCodex = `# Keep all unrelated settings.
model = "gpt-6.1-sol"
model_provider = "copilot_proxy"

[features]
multi_agent = true

[model_providers.copilot_proxy]
name = "My existing proxy label"
base_url = "http://localhost:4141/v1"
wire_api = "responses"

[mcp_servers.local]
command = "fixture-mcp"
args = ["--preserve", "me"]
`

describe("agent configuration inspection", () => {
  test("keeps each configured model independent and preserves Claude aliases", async () => {
    const claudePath = await seed("claude-code", existingClaude)
    const codexPath = await seed("codex", existingCodex)
    const views = await inspect()

    expect(views[0]?.model).toEqual({
      kind: "configured",
      exact: "claude-sonnet-5.5[1m]",
      catalogId: "claude-sonnet-5.5",
    })
    expect(views[1]?.model).toEqual({
      kind: "configured",
      exact: "gpt-6.1-sol",
      catalogId: "gpt-6.1-sol",
    })
    expect(views[0]?.status).toBe("configured")
    expect(views[1]?.status).toBe("configured")
    expect(await configure("claude-code")).toMatchObject({ kind: "unchanged" })
    expect(await configure("codex")).toMatchObject({ kind: "unchanged" })
    expect(await readFile(claudePath, "utf8")).toBe(existingClaude)
    expect(await readFile(codexPath, "utf8")).toBe(existingCodex)
    expect(JSON.stringify(views)).not.toContain("fixture-existing-claude-auth")
  })

  test("honors the existing root Claude model without introducing an env override", async () => {
    const text =
      '{ "model": "claude-sonnet-5.5[1m]", "env": { "ANTHROPIC_BASE_URL": "http://localhost:4141", "ANTHROPIC_AUTH_TOKEN": "fixture" } }'
    const path = await seed("claude-code", text)
    expect((await inspect())[0]?.model).toMatchObject({
      kind: "configured",
      exact: "claude-sonnet-5.5[1m]",
    })
    expect(await configure("claude-code")).toMatchObject({ kind: "unchanged" })
    expect(await readFile(path, "utf8")).toBe(text)
  })

  test("uses proposals only for agents whose model field is absent", async () => {
    const views = await inspect()
    expect(views.map((view) => view.model)).toEqual([
      { kind: "proposed", catalogId: "claude-sonnet-5.5" },
      { kind: "proposed", catalogId: "gpt-6.1-sol" },
      { kind: "proposed", catalogId: "claude-sonnet-5.5" },
    ])
    expect(views.every((view) => view.status === "missing")).toBe(true)
  })

  test("finds the existing proxy roots and omits unsafe endpoint credentials", async () => {
    await seed("claude-code", existingClaude)
    await seed("codex", existingCodex)
    await seed(
      "opencode",
      '{ "model": "copilot_proxy/example", "provider": { "copilot_proxy": { "options": { "baseURL": "https://user:fixture-secret@example.com/v1?api_key=fixture-secret" } } } }',
    )
    expect(
      (await configuredProxyRoots(homeDirectory)).map((root) =>
        root.toString(),
      ),
    ).toEqual(["http://localhost:4141"])
    expect(JSON.stringify(await inspect())).not.toContain("fixture-secret")
  })

  test("provides literal native auth candidates after unauthenticated probes without publishing them", async () => {
    await seed("claude-code", existingClaude)
    await seed(
      "codex",
      existingCodex.replace(
        'wire_api = "responses"',
        'wire_api = "responses"\nexperimental_bearer_token = "fixture-codex-key"',
      ),
    )
    const candidates = await configuredProxyConnections(homeDirectory)
    expect(
      candidates.map((candidate) => candidate.authentication.kind),
    ).toEqual(["none", "keyed", "keyed"])
    expect(candidates.map((candidate) => candidate.authentication)).toEqual([
      { kind: "none" },
      { kind: "keyed", key: "fixture-existing-claude-auth" },
      { kind: "keyed", key: "fixture-codex-key" },
    ])
    const views = JSON.stringify(await inspect())
    expect(views).not.toContain("fixture-existing-claude-auth")
    expect(views).not.toContain("fixture-codex-key")
  })

  test("does not resolve command, environment or file credential references for discovery", async () => {
    await seed(
      "codex",
      existingCodex.replace(
        'wire_api = "responses"',
        'wire_api = "responses"\nenv_key = "MY_EXISTING_KEY"',
      ),
    )
    await seed(
      "opencode",
      '{ "model": "copilot_proxy/example", "provider": { "copilot_proxy": { "options": { "baseURL": "http://localhost:4141/v1", "apiKey": "{file:fixture-secret-path}" } } } }',
    )
    expect(
      (await configuredProxyConnections(homeDirectory)).map(
        (candidate) => candidate.authentication,
      ),
    ).toEqual([{ kind: "none" }])
  })
})

describe("missing-only configuration", () => {
  test("adds OpenCode provider settings while preserving comments, MCP and permissions", async () => {
    const before = `{
  // The operator's MCP server must survive.
  "$schema": "https://opencode.ai/config.json",
  "permission": { "bash": "ask", "edit": false },
  "mcp": { "local": { "type": "local", "command": ["fixture-mcp"], "enabled": true } },
}
`
    const path = await seed("opencode", before)
    const result = await configure("opencode")
    expect(result.kind).toBe("added")
    const after = await readFile(path, "utf8")
    const parsed = jsonDocument(after)
    expect(parsed.permission).toEqual(jsonDocument(before).permission)
    expect(parsed.mcp).toEqual(jsonDocument(before).mcp)
    expect(parsed.model).toBe("copilot_proxy/claude-sonnet-5.5")
    expect(parsed.provider).toMatchObject({
      copilot_proxy: { options: { baseURL: connection.apiUrl } },
    })
    expect(JSON.stringify(parsed.provider)).not.toContain("apiKey")
    expect(after).toContain("// The operator's MCP server must survive.")
    expect(await configure("opencode")).toMatchObject({ kind: "unchanged" })
    expect(await readFile(path, "utf8")).toBe(after)
  })

  test("inserts missing TOML values inside the existing provider table", async () => {
    const before = existingCodex.replace(
      'base_url = "http://localhost:4141/v1"\n',
      "",
    )
    const path = await seed("codex", before)
    expect(await configure("codex")).toMatchObject({ kind: "added" })
    const after = await readFile(path, "utf8")
    const parsed = parseToml(after)
    expect(parsed.model_providers).toMatchObject({
      copilot_proxy: {
        name: "My existing proxy label",
        base_url: connection.apiUrl,
      },
    })
    expect(parsed.features).toEqual(parseToml(before).features)
    expect(parsed.mcp_servers).toEqual(parseToml(before).mcp_servers)
    expect(after).toContain("# Keep all unrelated settings.")
  })

  test("adds root TOML fields before tables instead of placing them in unrelated settings", async () => {
    const before = "# Existing options.\n[features]\nmulti_agent = true\n"
    const path = await seed("codex", before)
    expect(await configure("codex")).toMatchObject({ kind: "added" })
    const parsed = parseToml(await readFile(path, "utf8"))
    expect(parsed.model).toBe("gpt-6.1-sol")
    expect(parsed.model_provider).toBe("copilot_proxy")
    expect(parsed.features).toEqual({ multi_agent: true })
    expect(parsed.model_providers).toMatchObject({
      copilot_proxy: { base_url: connection.apiUrl, wire_api: "responses" },
    })
  })

  test("supports existing dotted and quoted TOML provider assignments", async () => {
    const before =
      'model = "gpt-6.1-sol"\nmodel_provider = "copilot_proxy"\nmodel_providers."copilot_proxy".name = "Keep label"\n[features]\nmulti_agent = true\n'
    const path = await seed("codex", before)
    expect(await configure("codex")).toMatchObject({ kind: "added" })
    expect(parseToml(await readFile(path, "utf8"))).toMatchObject({
      model_providers: {
        copilot_proxy: { name: "Keep label", base_url: connection.apiUrl },
      },
      features: { multi_agent: true },
    })
  })

  test("preserves unrelated TOML dates, large integers and arrays while adding configuration", async () => {
    const before =
      '# Preserve typed values.\nwhen = 1979-05-27T07:32:00Z\nhuge = 9223372036854775807\nratio = inf\nitems = [{ enabled = false, command = ["fixture", "arg"] }]\n'
    const path = await seed("codex", before)
    expect(await configure("codex")).toMatchObject({ kind: "added" })
    const after = parseToml(await readFile(path, "utf8"), {
      integersAsBigInt: "asNeeded",
    })
    const original = parseToml(before, { integersAsBigInt: "asNeeded" })
    for (const key of Object.keys(original))
      expect(after[key]).toEqual(original[key])
  })

  test("preserves an independently configured OpenCode model and existing limits", async () => {
    const before =
      '{ "model": "copilot_proxy/gpt-6.1-sol", "small_model": "operator/small", "provider": { "copilot_proxy": { "models": { "gpt-6.1-sol": { "name": "Existing label", "limit": { "context": 123456, "output": 5432 } } } } } }'
    const path = await seed("opencode", before)
    expect(await configure("opencode")).toMatchObject({
      kind: "added",
      view: {
        model: {
          kind: "configured",
          exact: "copilot_proxy/gpt-6.1-sol",
          catalogId: "gpt-6.1-sol",
        },
      },
    })
    expect(jsonDocument(await readFile(path, "utf8"))).toMatchObject({
      model: "copilot_proxy/gpt-6.1-sol",
      small_model: "operator/small",
      provider: {
        copilot_proxy: {
          models: {
            "gpt-6.1-sol": {
              name: "Existing label",
              limit: { context: 123456, output: 5432 },
            },
          },
        },
      },
    })
  })

  test("preserves existing null and false values and refuses to overwrite them", async () => {
    const before =
      '{ "env": { "ANTHROPIC_BASE_URL": null, "ANTHROPIC_MODEL": false }, "permissions": false }'
    const path = await seed("claude-code", before)
    expect(await configure("claude-code")).toMatchObject({ kind: "conflict" })
    expect(await readFile(path, "utf8")).toBe(before)
  })

  test("preserves a configured model while adding a missing endpoint and flags", async () => {
    const before =
      '{ "env": { "ANTHROPIC_MODEL": "claude-sonnet-5.5[1m]", "ANTHROPIC_AUTH_TOKEN": "existing", "DISABLE_NON_ESSENTIAL_MODEL_CALLS": false } }'
    const path = await seed("claude-code", before)
    expect(await configure("claude-code")).toMatchObject({ kind: "added" })
    expect(jsonDocument(await readFile(path, "utf8")).env).toMatchObject({
      ANTHROPIC_MODEL: "claude-sonnet-5.5[1m]",
      ANTHROPIC_BASE_URL: connection.rootUrl,
      ANTHROPIC_AUTH_TOKEN: "existing",
      DISABLE_NON_ESSENTIAL_MODEL_CALLS: false,
    })
  })

  test("refuses a conflicting endpoint without partially adding other settings", async () => {
    const before =
      '{ "env": { "ANTHROPIC_BASE_URL": "http://localhost:4142" } }'
    const path = await seed("claude-code", before)
    const result = await configure("claude-code")
    expect(result).toMatchObject({
      kind: "conflict",
      fields: ["env.ANTHROPIC_BASE_URL"],
    })
    expect(await readFile(path, "utf8")).toBe(before)
  })

  test("adds no Codex auth requirement for an unkeyed gateway", async () => {
    expect(await configure("codex")).toMatchObject({ kind: "added" })
    const parsed = parseToml(await readFile(configPath("codex"), "utf8"))
    expect(parsed.model_providers).toMatchObject({
      copilot_proxy: { base_url: connection.apiUrl },
    })
    expect(JSON.stringify(parsed)).not.toContain("env_key")
    expect(JSON.stringify(parsed)).not.toContain("experimental_bearer_token")
  })

  test("uses the actual keyed Codex bearer value without exposing it in results", async () => {
    const result = await configure("codex", true)
    expect(result.kind).toBe("added")
    expect(
      parseToml(await readFile(configPath("codex"), "utf8")),
    ).toMatchObject({
      model_providers: {
        copilot_proxy: { experimental_bearer_token: "fixture-local-api-key" },
      },
    })
    expect(JSON.stringify(result)).not.toContain("fixture-local-api-key")
    expect(await configure("codex", true)).toMatchObject({ kind: "unchanged" })
  })

  test("preserves a pre-existing Codex environment credential mechanism", async () => {
    const before = existingCodex.replace(
      'wire_api = "responses"',
      'wire_api = "responses"\nenv_key = "MY_EXISTING_PROXY_KEY"',
    )
    const path = await seed("codex", before)
    expect(await configure("codex", true)).toMatchObject({ kind: "unchanged" })
    expect(await readFile(path, "utf8")).toBe(before)
  })

  test("preserves a symlink and the resolved configuration permissions", async () => {
    const destination = join(homeDirectory, "shared-config.toml")
    const path = configPath("codex")
    await writeFile(destination, "# Symlink target.\n")
    await chmod(destination, 0o640)
    const beforeMode = (await stat(destination)).mode & 0o777
    await mkdir(dirname(path), { recursive: true })
    await symlink(destination, path)
    expect(await configure("codex")).toMatchObject({ kind: "added" })
    expect((await lstat(path)).isSymbolicLink()).toBe(true)
    expect(await readlink(path)).toBe(destination)
    expect((await stat(destination)).mode & 0o777).toBe(beforeMode)
    const parsed = parseToml(await readFile(destination, "utf8"))
    expect(parsed.model).toBe("gpt-6.1-sol")
  })

  test("serializes repeated button clicks without duplicate additions", async () => {
    const results = await Promise.all([
      configure("opencode"),
      configure("opencode"),
    ])
    expect(results.map((result) => result.kind).sort()).toEqual([
      "added",
      "unchanged",
    ])
    const after = await readFile(configPath("opencode"), "utf8")
    expect(jsonDocument(after).model).toBe("copilot_proxy/claude-sonnet-5.5")
    expect(await configure("opencode")).toMatchObject({ kind: "unchanged" })
    expect(await readFile(configPath("opencode"), "utf8")).toBe(after)
  })
})

describe("configuration refusal", () => {
  test("leaves malformed TOML untouched and omits source secrets from errors", async () => {
    const before =
      'model = "gpt-6.1-sol"\nsecret = "fixture-secret-without-a-closing-quote\n'
    const path = await seed("codex", before)
    const result = await configure("codex")
    expect(result.kind).toBe("invalid")
    expect(JSON.stringify(result)).not.toContain("fixture-secret")
    expect(await readFile(path, "utf8")).toBe(before)
  })

  test("refuses duplicate JSONC properties rather than editing an ambiguous value", async () => {
    const before =
      '{ "env": { "ANTHROPIC_MODEL": "first", "ANTHROPIC_MODEL": "second" } }'
    const path = await seed("claude-code", before)
    expect(await configure("claude-code")).toMatchObject({ kind: "invalid" })
    expect(await readFile(path, "utf8")).toBe(before)
  })

  test("preserves a broken configuration symlink instead of replacing it", async () => {
    const path = configPath("codex")
    const destination = join(homeDirectory, "missing-config.toml")
    await mkdir(dirname(path), { recursive: true })
    await symlink(destination, path)
    expect(await configure("codex")).toMatchObject({ kind: "invalid" })
    expect((await lstat(path)).isSymbolicLink()).toBe(true)
    expect(await readlink(path)).toBe(destination)
  })

  test("refuses an inline TOML layout that cannot be extended without rewriting it", async () => {
    const before =
      'model = "gpt-6.1-sol"\nmodel_provider = "copilot_proxy"\nmodel_providers = { copilot_proxy = { name = "Keep" } }\n'
    const path = await seed("codex", before)
    expect(await configure("codex")).toMatchObject({ kind: "invalid" })
    expect(await readFile(path, "utf8")).toBe(before)
  })

  test("refuses an observed edit made while the configuration addition is being prepared", async () => {
    const path = await seed(
      "codex",
      `# Initial configuration. ${"x".repeat(256_000)}\n`,
    )
    const edited = '# User edit during Configure.\nmodel = "operator-model"\n'
    const source = `
      const { readdirSync, writeFileSync } = require("node:fs");
      process.stdout.write("ready\\n");
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (readdirSync(${JSON.stringify(dirname(path))}).some(name => name !== "config.toml")) {
          writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(edited)});
          process.exit(0);
        }
      }
      process.exit(2);
    `
    const editor = spawn(process.execPath, ["-e", source], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    const exit = once(editor, "exit")
    try {
      await once(editor.stdout, "data")
      const result = await configure("codex")
      expect((await exit)[0]).toBe(0)
      expect(result.kind).toBe("conflict")
      expect(await readFile(path, "utf8")).toBe(edited)
    } finally {
      if (editor.exitCode === null) editor.kill()
    }
  })

  test("requires an agent model choice before creating a missing configuration", async () => {
    const result = await configureMissingAgent({
      homeDirectory,
      target: "codex",
      connection,
      catalog,
      proposal: null,
    })
    expect(result.kind).toBe("invalid")
    expect(await lstat(configPath("codex")).catch(() => null)).toBeNull()
  })
})

describe("TOML lexing, BOM, and XDG handling", () => {
  test("configures Codex TOML with multiline strings and nested multiline arrays verbatim", async () => {
    const before = [
      'note = """',
      "[model_providers.copilot_proxy]",
      'base_url = "https://fake.example/v1"',
      '"""',
      String.raw`escaped = """\""" and trailing quote""""`,
      "literal = '''",
      "[model_providers.copilot_proxy]",
      "'''",
      "matrix = [\n  [1, 2],\n  [3, 4],\n]",
      "[features]\nmulti_agent = true\n",
    ].join("\n")
    const path = await seed("codex", before)
    expect(await configure("codex")).toMatchObject({ kind: "added" })
    const parsed = parseToml(await readFile(path, "utf8"))
    const original = parseToml(before)
    expect(parsed.note).toBe(original.note)
    expect(parsed.escaped).toBe(original.escaped)
    expect(parsed.literal).toBe(original.literal)
    expect(parsed.matrix).toEqual([
      [1, 2],
      [3, 4],
    ])
    expect(parsed.features).toEqual({ multi_agent: true })
    expect(parsed.model_providers).toMatchObject({
      copilot_proxy: { base_url: connection.apiUrl, wire_api: "responses" },
    })
    expect(await configure("codex")).toMatchObject({ kind: "unchanged" })
  })

  test("inspects and configures UTF-8 BOM-prefixed JSONC and TOML files cleanly", async () => {
    const claudePath = await seed(
      "claude-code",
      '\uFEFF{ "permissions": { "allow": ["Bash(git status:*)"] } }\n',
    )
    const opencodePath = join(
      getAgentConfigFolder("opencode", homeDirectory),
      "opencode.json",
    )
    await mkdir(dirname(opencodePath), { recursive: true })
    await writeFile(opencodePath, '\uFEFF{ "permission": { "bash": "ask" } }\n')
    const codexPath = await seed(
      "codex",
      "\uFEFF[features]\nmulti_agent = true\n",
    )

    expect((await inspect()).map((view) => view.status)).toEqual([
      "missing",
      "missing",
      "missing",
    ])
    expect(await configure("claude-code")).toMatchObject({ kind: "added" })
    expect(await configure("codex")).toMatchObject({ kind: "added" })
    expect(await configure("opencode")).toMatchObject({ kind: "added" })

    expect(jsonDocument(await readFile(claudePath, "utf8"))).toMatchObject({
      permissions: { allow: ["Bash(git status:*)"] },
      env: { ANTHROPIC_BASE_URL: connection.rootUrl },
    })
    expect(jsonDocument(await readFile(opencodePath, "utf8"))).toMatchObject({
      permission: { bash: "ask" },
      model: "copilot_proxy/claude-sonnet-5.5",
    })
    expect(parseToml(await readFile(codexPath, "utf8"))).toMatchObject({
      model: "gpt-6.1-sol",
      features: { multi_agent: true },
      model_providers: { copilot_proxy: { base_url: connection.apiUrl } },
    })
  })

  test("honors absolute XDG_CONFIG_HOME for OpenCode only for the real user home", () => {
    const previous = process.env.XDG_CONFIG_HOME
    try {
      const customXdg = join(homeDirectory, "custom-xdg")
      process.env.XDG_CONFIG_HOME = customXdg
      expect(getAgentConfigFolder("opencode", homedir())).toBe(
        join(customXdg, "opencode"),
      )
      expect(getAgentConfigFolder("opencode", homeDirectory)).toBe(
        join(homeDirectory, ".config", "opencode"),
      )
      process.env.XDG_CONFIG_HOME = "relative/xdg"
      expect(getAgentConfigFolder("opencode", homedir())).toBe(
        join(homedir(), ".config", "opencode"),
      )
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previous
    }
  })
})

describe("auth edge cases, stopped-gateway validation, and contract upgrades", () => {
  test("exempts OpenCode file secret references from keyed mismatch conflicts", async () => {
    const before = JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "copilot_proxy/claude-sonnet-5.5",
      provider: {
        copilot_proxy: {
          npm: "@ai-sdk/openai-compatible",
          name: "Copilot Proxy",
          options: { baseURL: connection.apiUrl, apiKey: "{file:~/.secret}" },
          models: { "claude-sonnet-5.5": { name: "Claude Sonnet 5.5" } },
        },
      },
    })
    const path = await seed("opencode", before)
    const views = await inspectAgentConfigs({
      homeDirectory,
      connection: keyedConnection,
      catalog,
      proposals,
    })
    expect(views[2]?.status).toBe("configured")
    expect(await configure("opencode", true)).toMatchObject({
      kind: "unchanged",
    })
    expect(await readFile(path, "utf8")).toBe(before)
  })

  test("flags an OpenCode model with an empty suffix after slash as conflicting", async () => {
    const before = JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "copilot_proxy/",
      provider: {
        copilot_proxy: {
          npm: "@ai-sdk/openai-compatible",
          name: "Copilot Proxy",
          options: { baseURL: connection.apiUrl },
        },
      },
    })
    const path = await seed("opencode", before)
    expect((await inspect())[2]).toMatchObject({ status: "conflicting" })
    const result = await configure("opencode")
    expect(result.kind).toBe("conflict")
    if (result.kind === "conflict") expect(result.fields).toContain("model")
    expect(await readFile(path, "utf8")).toBe(before)
  })

  test("matches case-insensitive Codex Bearer headers and rejects non-Bearer Authorization when keyed", async () => {
    const lowercaseBearer = `${existingCodex}\n[model_providers.copilot_proxy.http_headers]\nAuthorization = "bearer fixture-local-api-key"\n`
    await seed("codex", lowercaseBearer)
    const matchingViews = await inspectAgentConfigs({
      homeDirectory,
      connection: keyedConnection,
      catalog,
      proposals,
    })
    expect(matchingViews[1]?.status).toBe("configured")
    expect(await configure("codex", true)).toMatchObject({ kind: "unchanged" })
    expect(
      (await configuredProxyConnections(homeDirectory)).map(
        (candidate) => candidate.authentication,
      ),
    ).toContainEqual({ kind: "keyed", key: "fixture-local-api-key" })

    const basicAuth = lowercaseBearer.replace(
      'Authorization = "bearer fixture-local-api-key"',
      'Authorization = "Basic Zm9vOmJhcg=="',
    )
    const path = await seed("codex", basicAuth)
    const result = await configure("codex", true)
    expect(result.kind).toBe("conflict")
    if (result.kind === "conflict") {
      expect(result.fields).toContain(
        "model_providers.copilot_proxy.http_headers",
      )
    }
    expect(await readFile(path, "utf8")).toBe(basicAuth)
  })

  test("reports external non-loopback endpoints as conflicting even when the gateway is stopped", async () => {
    await seed(
      "claude-code",
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://api.anthropic.com",
          ANTHROPIC_MODEL: "claude-sonnet-5.5",
          ANTHROPIC_AUTH_TOKEN: "fixture-token",
        },
      }),
    )
    await seed(
      "codex",
      'model = "gpt-6.1-sol"\nmodel_provider = "openai"\n[model_providers.openai]\nbase_url = "https://api.openai.com/v1"\nwire_api = "responses"\n',
    )
    await seed(
      "opencode",
      JSON.stringify({
        model: "openai/gpt-6.1-sol",
        provider: {
          openai: {
            npm: "@ai-sdk/openai",
            options: { baseURL: "https://api.openai.com/v1" },
            models: { "gpt-6.1-sol": { name: "GPT 6.1 Sol" } },
          },
        },
      }),
    )
    const views = await inspectAgentConfigs({
      homeDirectory,
      connection: null,
      catalog,
      proposals,
    })
    expect(views.map((view) => view.status)).toEqual([
      "conflicting",
      "conflicting",
      "conflicting",
    ])
    expect(views[0]?.conflictFields).toContain("env.ANTHROPIC_BASE_URL")
    expect(views[1]?.conflictFields).toContain("model_provider")
    expect(views[1]?.conflictFields).toContain(
      "model_providers.openai.base_url",
    )
    expect(views[2]?.conflictFields).toContain("model")
    expect(views[2]?.conflictFields).toContain(
      "provider.openai.options.baseURL",
    )
  })

  test("accepts valid loopback endpoints and rejects wrong loopback paths when stopped", async () => {
    await seed("claude-code", existingClaude)
    await seed("codex", existingCodex)
    await seed(
      "opencode",
      JSON.stringify({
        model: "copilot_proxy/claude-sonnet-5.5",
        provider: {
          copilot_proxy: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "http://127.0.0.1:4141/v1" },
            models: { "claude-sonnet-5.5": { name: "Claude Sonnet 5.5" } },
          },
        },
      }),
    )
    const valid = await inspectAgentConfigs({
      homeDirectory,
      connection: null,
      catalog,
      proposals,
    })
    expect(valid.map((view) => view.status)).toEqual([
      "configured",
      "configured",
      "configured",
    ])

    await seed(
      "claude-code",
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://localhost:4141/v1",
          ANTHROPIC_MODEL: "claude-sonnet-5.5",
          ANTHROPIC_AUTH_TOKEN: "fixture-token",
        },
      }),
    )
    await seed(
      "codex",
      existingCodex.replace(
        "http://localhost:4141/v1",
        "http://localhost:4141",
      ),
    )
    const wrongPath = await inspectAgentConfigs({
      homeDirectory,
      connection: null,
      catalog,
      proposals,
    })
    expect(wrongPath[0]?.conflictFields).toContain("env.ANTHROPIC_BASE_URL")
    expect(wrongPath[1]?.conflictFields).toContain(
      "model_providers.copilot_proxy.base_url",
    )
  })

  test("upgrades partial persisted agent model choices and accepts optional catalog model type", () => {
    expect(agentModelChoicesSchema.parse({})).toEqual({
      "claude-code": null,
      codex: null,
      opencode: null,
    })
    expect(
      agentModelChoicesSchema.safeParse({ unknown: "gpt-6.1-sol" }).success,
    ).toBe(false)
    expect(modelSchema.parse(catalog[0]).type).toBeUndefined()
    expect(modelSchema.parse({ ...catalog[0], type: "embeddings" }).type).toBe(
      "embeddings",
    )
  })
})
