#!/usr/bin/env node

import { defineCommand } from "citty"
import clipboard from "clipboardy"
import consola from "consola"
import { parseArgs } from "node:util"
import { serve, type ServerHandler } from "srvx"
import { z } from "zod"

import type {
  CatalogModel,
  NativeConnection,
  ProxySession,
  RuntimeOverrides,
  ServiceSnapshot,
} from "./lib/proxy-contracts"

import {
  configuredProxyConnections,
  inspectAgentConfigs,
} from "./lib/agent-config"
import { probeLegacyProxy } from "./lib/legacy-proxy"
import { parseLocalApiKeys } from "./lib/local-auth"
import { ensurePaths } from "./lib/paths"
import { initProxyFromEnv } from "./lib/proxy"
import {
  nativeConnectionSchema,
  runtimeOverridesSchema,
} from "./lib/proxy-contracts"
import {
  cliProxyOptions,
  openProxySession,
  requireDefaultStandaloneProfile,
} from "./lib/proxy-session"
import { generateEnvScript } from "./lib/shell"
import { state } from "./lib/state"
import { setupCopilotToken, setupGitHubToken } from "./lib/token"
import { cacheModels, cacheVSCodeVersion } from "./lib/utils"
import { server } from "./server"

const runServerOptionsSchema = z.object({
  port: z.number().int().min(1024).max(65535),
  verbose: z.boolean(),
  accountType: z.enum(["individual", "business", "enterprise"]),
  manual: z.boolean(),
  rateLimit: z.number().nonnegative().optional(),
  rateLimitWait: z.boolean(),
  githubToken: z.string().min(1).max(4096).optional(),
  claudeCode: z.boolean(),
  showToken: z.boolean(),
  proxyEnv: z.boolean(),
  apiKey: z.string().max(64_000).optional(),
  responsesContextTrim: z.boolean(),
})
export type RunServerOptions = z.infer<typeof runServerOptionsSchema>

export function explicitCliRuntime(options: {
  rawArgs: Array<string>
  values: RunServerOptions
}): RuntimeOverrides {
  const parsed = parseArgs({
    args: options.rawArgs,
    tokens: true,
    strict: false,
    allowNegative: true,
    options: {
      port: { type: "string", short: "p" },
      verbose: { type: "boolean", short: "v" },
      "account-type": { type: "string", short: "a" },
      manual: { type: "boolean" },
      "rate-limit": { type: "string", short: "r" },
      wait: { type: "boolean", short: "w" },
      "github-token": { type: "string", short: "g" },
      "claude-code": { type: "boolean", short: "c" },
      "show-token": { type: "boolean" },
      "proxy-env": { type: "boolean" },
      "api-key": { type: "string" },
      "responses-context-trim": { type: "boolean" },
    },
  })
  const supplied = (name: string) =>
    parsed.tokens.some(
      (token) => token.kind === "option" && token.name === name,
    )
  const explicit: RuntimeOverrides = {}
  if (supplied("port")) explicit.port = options.values.port
  if (supplied("account-type"))
    explicit.accountType = options.values.accountType
  if (supplied("manual")) explicit.manualApprove = options.values.manual
  if (supplied("rate-limit"))
    explicit.rateLimitSeconds = options.values.rateLimit ?? null
  if (supplied("wait")) explicit.rateLimitWait = options.values.rateLimitWait
  if (supplied("responses-context-trim"))
    explicit.responsesContextTrim = options.values.responsesContextTrim
  if (supplied("proxy-env"))
    explicit.proxyFromEnvironment = options.values.proxyEnv
  if (supplied("api-key")) {
    const keys = parseLocalApiKeys(options.values.apiKey)
    explicit.authentication =
      keys.length > 0 ? { kind: "keyed", keys } : { kind: "none" }
  }
  return runtimeOverridesSchema.parse(explicit)
}

function matchingOrigin(left: string, right: string): boolean {
  return new URL(left).port === new URL(right).port
}

export async function claudeCodeCommand(options: {
  homeDirectory: string
  connection: NativeConnection
  catalog: Array<CatalogModel>
  selectModel?: (choices: Array<string>) => Promise<string>
}): Promise<string> {
  const configs = await inspectAgentConfigs({
    homeDirectory: options.homeDirectory,
    connection: options.connection,
    catalog: options.catalog,
    proposals: { "claude-code": null, codex: null, opencode: null },
  })
  const claude = configs.find((config) => config.target === "claude-code")
  const configured = await configuredProxyConnections(options.homeDirectory)
  const authMatches =
    options.connection.authentication.kind === "none"
    || configured.some(
      (candidate) =>
        matchingOrigin(candidate.rootUrl, options.connection.rootUrl)
        && candidate.authentication.kind === "keyed"
        && options.connection.authentication.kind === "keyed"
        && candidate.authentication.key
          === options.connection.authentication.key,
    )
  if (
    claude?.model.kind === "configured"
    && claude.rootUrl
    && matchingOrigin(claude.rootUrl, options.connection.rootUrl)
    && authMatches
  )
    return "claude"
  const choices = options.catalog
    .filter((model) =>
      model.endpoints.some((endpoint) =>
        ["/chat/completions", "/responses"].includes(endpoint),
      ),
    )
    .map((model) => model.id)
  const select =
    options.selectModel
    ?? ((ids: Array<string>) =>
      consola.prompt("Choose a model for Claude Code", {
        type: "select",
        options: ids,
      }))
  const selected =
    claude?.model.kind === "configured" ?
      claude.model.exact
    : await select(choices)
  if (
    !selected
    || (claude?.model.kind !== "configured" && !choices.includes(selected))
  )
    throw new Error("Choose an available Claude Code model.")
  return generateEnvScript(
    {
      ANTHROPIC_BASE_URL: options.connection.rootUrl,
      ANTHROPIC_AUTH_TOKEN:
        options.connection.authentication.kind === "keyed" ?
          options.connection.authentication.key
        : undefined,
      ANTHROPIC_MODEL: selected,
      DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
    "claude",
  )
}

async function copyClaudeCommand(
  options: Parameters<typeof claudeCodeCommand>[0],
): Promise<void> {
  const command = await claudeCodeCommand(options)
  try {
    clipboard.writeSync(command)
    consola.success("Copied Claude Code launch command.")
  } catch {
    consola.warn(
      "Could not copy the launch command. Copy it from Agents in Copilot Proxy.",
    )
  }
}

async function sessionConnection(options: {
  session: Extract<ProxySession, { kind: "managed" | "legacy" }>
  homeDirectory: string
  explicit: RuntimeOverrides
}): Promise<NativeConnection | null> {
  if (options.session.kind === "managed") return options.session.connection()
  const snapshot = await options.session.read()
  if (snapshot.connection.authentication.kind === "none")
    return nativeConnectionSchema.parse(snapshot.connection)
  const candidates = await configuredProxyConnections(options.homeDirectory)
  if (options.explicit.authentication?.kind === "keyed") {
    for (const key of options.explicit.authentication.keys)
      candidates.push(
        nativeConnectionSchema.parse({
          ...snapshot.connection,
          authentication: { kind: "keyed", key },
        }),
      )
  }
  for (const candidate of candidates) {
    if (
      !matchingOrigin(candidate.rootUrl, snapshot.connection.rootUrl)
      || candidate.authentication.kind !== "keyed"
    )
      continue
    const probe = await probeLegacyProxy({ connection: candidate })
    if (probe) {
      await probe.release()
      return nativeConnectionSchema.parse({
        ...candidate,
        rootUrl: snapshot.connection.rootUrl,
        apiUrl: snapshot.connection.apiUrl,
      })
    }
  }
  return null
}

export async function monitorProxySession(options: {
  session: Extract<ProxySession, { kind: "managed" | "legacy" }>
  signal?: AbortSignal
}): Promise<void> {
  const { session, signal } = options
  await new Promise<void>((resolve, reject) => {
    let settled = false
    let unsubscribe: (() => void) | null = null
    const timer = setInterval(() => {
      void session
        .read()
        .then(observe)
        .catch((error: unknown) => {
          void finish(false, error)
        })
    }, 2000)
    const interrupt = () => {
      void finish(true)
    }
    const finish = async (interrupted: boolean, error?: unknown) => {
      if (settled) return
      settled = true
      clearInterval(timer)
      unsubscribe?.()
      process.removeListener("SIGINT", interrupt)
      process.removeListener("SIGTERM", interrupt)
      signal?.removeEventListener("abort", interrupt)
      try {
        if (
          interrupted
          && session.kind === "managed"
          && session.lifecycle.kind === "creator"
        )
          await session.lifecycle.stopCreatedGateway()
        await session.release()
        if (error)
          reject(
            error instanceof Error ? error : (
              new Error("The proxy session failed.")
            ),
          )
        else resolve()
      } catch (caught) {
        reject(
          caught instanceof Error ? caught : (
            new Error("The proxy session could not close.")
          ),
        )
      }
    }
    const observe = (snapshot: ServiceSnapshot) => {
      if (snapshot.kind === "managed" && snapshot.gateway.kind === "stopped")
        void finish(false)
      if (snapshot.kind === "legacy" && snapshot.status === "unreachable")
        void finish(
          false,
          new Error("The existing CLI proxy is no longer reachable."),
        )
    }
    process.once("SIGINT", interrupt)
    process.once("SIGTERM", interrupt)
    signal?.addEventListener("abort", interrupt, { once: true })
    unsubscribe = session.subscribe(observe)
    if (signal?.aborted) interrupt()
  })
}

export async function runStart(options: {
  values: RunServerOptions
  explicit: RuntimeOverrides
  homeDirectory?: string
  stateDirectory?: string
  signal?: AbortSignal
}): Promise<void> {
  const values = runServerOptionsSchema.parse(options.values)
  const context = await cliProxyOptions(options)
  const session = await openProxySession({
    ...context,
    intent: {
      kind: "ensure-running",
      explicit: options.explicit,
      credential:
        values.githubToken ?
          {
            kind: "provided-token",
            value: values.githubToken,
            persistence: "session",
          }
        : { kind: "native-saved-account" },
    },
  })
  if (session.kind === "unavailable") throw new Error(session.message)
  if (session.kind === "standalone") {
    requireDefaultStandaloneProfile(context.homeDirectory)
    return runServer(values)
  }
  if (values.verbose) consola.level = 5
  if (values.showToken)
    consola.warn("Native credentials remain in Copilot Proxy storage.")
  try {
    const snapshot = await session.read()
    let url: string | null = null
    if (snapshot.kind === "legacy") url = snapshot.connection.rootUrl
    else if (snapshot.gateway.kind === "running")
      url = snapshot.gateway.connection.rootUrl
    consola.success(
      `Connected to ${url ?? "Copilot Proxy"}${snapshot.kind === "legacy" ? " (existing CLI, read-only controls)" : ""}.`,
    )
    if (values.claudeCode) {
      const connection = await sessionConnection({
        session,
        homeDirectory: context.homeDirectory,
        explicit: options.explicit,
      })
      if (!connection)
        throw new Error(
          "The active proxy authentication key could not be read. Open Agents in Copilot Proxy.",
        )
      await copyClaudeCommand({
        homeDirectory: context.homeDirectory,
        connection,
        catalog: snapshot.catalog,
      })
    }
    await monitorProxySession({ session, signal: options.signal })
  } finally {
    await session.release()
  }
}

async function standaloneClaudeCommand(serverUrl: string): Promise<void> {
  const context = await cliProxyOptions()
  const models: Array<CatalogModel> =
    state.models?.data.map((model) => ({
      id: model.id,
      name: model.name,
      vendor: model.vendor,
      contextWindow:
        model.capabilities.limits.max_context_window_tokens ?? null,
      maxOutput: model.capabilities.limits.max_output_tokens ?? null,
      supports: [],
      endpoints: model.supported_endpoints ?? [
        "/chat/completions",
        "/responses",
      ],
      preview: model.preview,
    })) ?? []
  const key = state.localApiKeys[0]
  await copyClaudeCommand({
    homeDirectory: context.homeDirectory,
    catalog: models,
    connection: nativeConnectionSchema.parse({
      rootUrl: serverUrl,
      apiUrl: `${serverUrl}/v1`,
      authentication: key ? { kind: "keyed", key } : { kind: "none" },
    }),
  })
}

export async function runServer(options: RunServerOptions): Promise<void> {
  if (options.proxyEnv) {
    initProxyFromEnv()
  }

  if (options.verbose) {
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  state.accountType = options.accountType
  if (options.accountType !== "individual") {
    consola.info(`Using ${options.accountType} plan GitHub account`)
  }

  state.manualApprove = options.manual
  state.rateLimitSeconds = options.rateLimit
  state.rateLimitWait = options.rateLimitWait
  state.showToken = options.showToken
  state.localApiKeys = parseLocalApiKeys(options.apiKey)
  state.responsesContextTrim = options.responsesContextTrim
  if (state.responsesContextTrim) {
    consola.warn(
      "Responses context trimming enabled — old history will be rewritten to fit an estimated budget, which degrades prompt caching",
    )
  }
  if (state.localApiKeys.length > 0) {
    consola.info("Local API-key auth enabled")
  }

  if (options.githubToken) {
    state.githubToken = options.githubToken
    consola.info("Using provided GitHub token")
  }

  await ensurePaths()
  await cacheVSCodeVersion()

  if (!options.githubToken) {
    await setupGitHubToken()
  }

  await setupCopilotToken()
  await cacheModels()

  consola.info(
    `Available models (${state.models?.data.length ?? 0}):\n${state.models?.data.map((model) => `- ${model.id}`).join("\n") ?? "None"}`,
  )

  const serverUrl = `http://localhost:${options.port}`

  if (options.claudeCode) await standaloneClaudeCommand(serverUrl)

  consola.debug(
    `🌐 Usage Viewer: https://voidsteed.github.io/copilot-proxy-api/dashboard.html?endpoint=${serverUrl}/usage`,
  )

  serve({
    fetch: server.fetch as ServerHandler,
    port: options.port,
    // Bun's HTTP server defaults to a 10s idleTimeout, which closes the
    // client socket while we're still waiting on Copilot's upstream
    // response (Copilot can take 10-60s for large opus requests). Setting
    // to 0 disables the idle timeout entirely. Claude Code reports this
    // as "API Error: The socket connection was closed unexpectedly".
    bun: { idleTimeout: 0 },
  })

  consola.success(
    `Ready — ${state.models?.data.length ?? 0} models available. Point your client at ${serverUrl}`,
  )
}

export const start = defineCommand({
  meta: {
    name: "start",
    description: "Start or attach to the shared Copilot Proxy",
  },
  args: {
    port: {
      alias: "p",
      type: "string",
      default: "4141",
      description: "Port to listen on",
    },
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    "account-type": {
      alias: "a",
      type: "string",
      default: "individual",
      description: "Account type to use (individual, business, enterprise)",
    },
    manual: {
      type: "boolean",
      default: false,
      description: "Enable manual request approval",
    },
    "rate-limit": {
      alias: "r",
      type: "string",
      description: "Rate limit in seconds between requests",
    },
    wait: {
      alias: "w",
      type: "boolean",
      default: false,
      description:
        "Wait instead of error when rate limit is hit. Has no effect if rate limit is not set",
    },
    "github-token": {
      alias: "g",
      type: "string",
      description: "Use an explicitly supplied GitHub token for this session",
    },
    "claude-code": {
      alias: "c",
      type: "boolean",
      default: false,
      description:
        "Generate a command to launch Claude Code with Copilot API config",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Show tokens on fetch and refresh in standalone CLI mode",
    },
    "proxy-env": {
      type: "boolean",
      default: false,
      description: "Initialize proxy from environment variables",
    },
    "api-key": {
      type: "string",
      description:
        "Require one of these comma-separated local API keys for proxy routes",
    },
    "responses-context-trim": {
      type: "boolean",
      default: false,
      description:
        "Trim old /responses history to fit an estimated token budget. Lossy: rewrites conversation history and breaks prompt caching. Off by default — Copilot enforces its own limits",
    },
  },
  run({ args, rawArgs }) {
    const rateLimitRaw = args["rate-limit"]
    const rateLimit =
      rateLimitRaw === undefined ? undefined : Number(rateLimitRaw)

    const values = runServerOptionsSchema.parse({
      port: Number(args.port),
      verbose: args.verbose,
      accountType: args["account-type"],
      manual: args.manual,
      rateLimit,
      rateLimitWait: args.wait,
      githubToken: args["github-token"],
      claudeCode: args["claude-code"],
      showToken: args["show-token"],
      proxyEnv: args["proxy-env"],
      apiKey: args["api-key"],
      responsesContextTrim: args["responses-context-trim"],
    })
    return runStart({
      values,
      explicit: explicitCliRuntime({ rawArgs, values }),
    })
  },
})
