import type {
  AgentConfigView,
  AgentModel,
  CatalogModel,
  ConfigurableAgent,
  ConfigureMissingAgentOptions,
  ConfigureResult,
  InspectAgentConfigsOptions,
  LoopbackRootUrl,
  NativeConnection,
} from "~/lib/proxy-contracts"

import {
  loopbackRootUrlSchema,
  nativeConnectionSchema,
} from "~/lib/proxy-contracts"

import type { Addition, ConfigObject, ConfigRead } from "./agent-config-files"

import {
  agentConfigFolder,
  configuredHeader,
  entryAt,
  existingString,
  literalCredentials,
  readAgentConfig,
  withConfigWriter,
  writeConfigAdditions,
} from "./agent-config-files"
const targets: Array<ConfigurableAgent> = ["claude-code", "codex", "opencode"]
const invalidSyntax =
  "The configuration file cannot be parsed. Fix its syntax before configuring."

interface Plan {
  view: AgentConfigView
  additions: Array<Addition>
}

interface Inspection {
  document: ConfigObject
  connection: NativeConnection | null
  catalog: Array<CatalogModel>
  missing: Set<string>
  conflicts: Set<string>
  additions: Array<Addition>
}

interface Field {
  path: Array<string>
  value: Addition["value"] | null
}

export function getAgentConfigFolder(
  target: ConfigurableAgent,
  homeDirectory: string,
): string {
  return agentConfigFolder(target, homeDirectory)
}

function addMissing(
  state: Inspection,
  { path, value }: Field,
  required = false,
): void {
  const entry = entryAt(state.document, path)
  if (entry.kind === "blocked") {
    state.conflicts.add(entry.path.join("."))
  } else if (entry.kind === "absent") {
    if (required) state.missing.add(path.join("."))
    if (value !== null) state.additions.push({ path, value })
  }
}

function stringField(
  state: Inspection,
  { path, value }: Field & { value: string | null },
  required = false,
): string | null {
  addMissing(state, { path: path, value: value }, required)
  const entry = entryAt(state.document, path)
  if (
    entry.kind === "existing"
    && (typeof entry.value !== "string" || entry.value.length === 0)
  ) {
    state.conflicts.add(path.join("."))
  }
  return existingString(state.document, path)
}

function safeUrl(value: string | null): URL | null {
  if (value === null) return null
  try {
    const url = new URL(value)
    return (
        ["http:", "https:"].includes(url.protocol)
          && !url.username
          && !url.password
          && !url.search
          && !url.hash
      ) ?
        url
      : null
  } catch {
    return null
  }
}

function endpointHost(url: URL): string {
  return ["[::1]", "127.0.0.1", "localhost"].includes(url.hostname) ? "loopback"
    : url.hostname
}

function sameEndpoint(left: string, right: string): boolean {
  const first = safeUrl(left)
  const second = safeUrl(right)
  if (!first || !second) return false
  return (
    first.protocol === second.protocol
    && endpointHost(first) === endpointHost(second)
    && first.port === second.port
    && first.pathname.replace(/\/+$/u, "")
      === second.pathname.replace(/\/+$/u, "")
  )
}

function endpointField(
  state: Inspection,
  path: Array<string>,
  expected: string | null,
): string | null {
  const configured = stringField(state, { path: path, value: expected }, true)
  if (
    configured !== null
    && (!safeUrl(configured)
      || (expected !== null && !sameEndpoint(configured, expected)))
  ) {
    state.conflicts.add(path.join("."))
  }
  return safeUrl(configured) ? configured : null
}

function rootFromApi(apiUrl: string | null): string | null {
  const url = safeUrl(apiUrl)
  if (!url || !/^\/v1\/?$/u.test(url.pathname)) return null
  return url.origin
}

function modelInformation(
  state: Inspection,
  {
    target,
    path,
    proposal,
  }: {
    target: ConfigurableAgent
    path: Array<string>
    proposal: string | null
  },
): AgentModel {
  const value =
    proposal === null ? null : configuredModelValue(target, proposal)
  const exact = stringField(state, { path, value }, true)
  if (exact !== null && exact.length > 1000) {
    state.conflicts.add(path.join("."))
    return { kind: "missing" }
  }
  if (exact === null) {
    return (
        entryAt(state.document, path).kind === "absent" && proposal !== null
      ) ?
        { kind: "proposed", catalogId: proposal }
      : { kind: "missing" }
  }
  const id = catalogModelId(target, exact)
  return {
    kind: "configured",
    exact,
    catalogId: state.catalog.some((model) => model.id === id) ? id : null,
  }
}

function configuredModelValue(
  target: ConfigurableAgent,
  modelId: string,
): string {
  return target === "opencode" && modelId.length > 0 ?
      `copilot_proxy/${modelId}`
    : modelId
}

function catalogModelId(target: ConfigurableAgent, exact: string): string {
  if (target === "opencode") return exact.slice(exact.indexOf("/") + 1)
  if (target === "claude-code") return exact.replace(/\[1m\]$/u, "")
  return exact
}

function claudeAuthentication(state: Inspection): boolean {
  const tokenPath = ["env", "ANTHROPIC_AUTH_TOKEN"]
  const token = existingString(state.document, tokenPath)
  const apiKey = existingString(state.document, ["env", "ANTHROPIC_API_KEY"])
  const helper = existingString(state.document, ["apiKeyHelper"])
  if (!token && !apiKey && !helper) {
    let value: string | null = null
    if (state.connection !== null) {
      value =
        state.connection.authentication.kind === "keyed" ?
          state.connection.authentication.key
        : "dummy"
    }
    stringField(state, { path: tokenPath, value }, true)
  }
  if (
    state.connection?.authentication.kind === "keyed"
    && (token ?? apiKey) !== null
    && (token ?? apiKey) !== state.connection.authentication.key
  ) {
    state.conflicts.add(
      token ? "env.ANTHROPIC_AUTH_TOKEN" : "env.ANTHROPIC_API_KEY",
    )
  }
  return Boolean(token || apiKey || helper)
}

function claudePlan(state: Inspection, proposal: string | null) {
  const modelPath =
    (
      entryAt(state.document, ["env", "ANTHROPIC_MODEL"]).kind === "absent"
      && entryAt(state.document, ["model"]).kind !== "absent"
    ) ?
      ["model"]
    : ["env", "ANTHROPIC_MODEL"]
  const model = modelInformation(state, {
    target: "claude-code",
    path: modelPath,
    proposal: proposal,
  })
  const rootUrl = endpointField(
    state,
    ["env", "ANTHROPIC_BASE_URL"],
    state.connection?.rootUrl ?? null,
  )
  const authenticationPresent = claudeAuthentication(state)
  addMissing(state, {
    path: ["env", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"],
    value: "1",
  })
  addMissing(state, {
    path: ["env", "DISABLE_NON_ESSENTIAL_MODEL_CALLS"],
    value: "1",
  })
  return { model, rootUrl, apiUrl: null, authenticationPresent }
}

function codexAuthentication(
  state: Inspection,
  provider: Array<string>,
): boolean {
  const bearerPath = [...provider, "experimental_bearer_token"]
  const bearer = existingString(state.document, bearerPath)
  const envKey = existingString(state.document, [...provider, "env_key"])
  const command = existingString(state.document, [
    ...provider,
    "auth",
    "command",
  ])
  const header = configuredHeader(
    state.document,
    [...provider, "http_headers"],
    "Authorization",
  )
  const apiKey = configuredHeader(
    state.document,
    [...provider, "http_headers"],
    "x-api-key",
  )
  const present = Boolean(bearer || envKey || command || header || apiKey)
  if (state.connection?.authentication.kind === "keyed") {
    if (!present)
      stringField(
        state,
        { path: bearerPath, value: state.connection.authentication.key },
        true,
      )
    const existingKey =
      bearer ?? (header?.startsWith("Bearer ") ? header.slice(7) : apiKey)
    if (
      existingKey !== null
      && existingKey !== state.connection.authentication.key
    )
      state.conflicts.add(
        bearer ? bearerPath.join(".") : [...provider, "http_headers"].join("."),
      )
  }
  const openaiAuth = entryAt(state.document, [
    ...provider,
    "requires_openai_auth",
  ])
  if (openaiAuth.kind === "existing" && openaiAuth.value !== false)
    state.conflicts.add([...provider, "requires_openai_auth"].join("."))
  return present
}

function isProxyProvider(
  state: Inspection,
  provider: string,
  url: string | null,
): boolean {
  if (provider === "copilot_proxy") return true
  return (
    url !== null
    && (state.connection === null || sameEndpoint(url, state.connection.apiUrl))
  )
}

function codexPlan(state: Inspection, proposal: string | null) {
  const model = modelInformation(state, {
    target: "codex",
    path: ["model"],
    proposal: proposal,
  })
  const selectedProvider =
    stringField(
      state,
      { path: ["model_provider"], value: "copilot_proxy" },
      true,
    ) ?? "copilot_proxy"
  const provider = ["model_providers", selectedProvider]
  const existingUrl = existingString(state.document, [...provider, "base_url"])
  if (!isProxyProvider(state, selectedProvider, existingUrl))
    state.conflicts.add("model_provider")
  const apiUrl = endpointField(
    state,
    [...provider, "base_url"],
    state.connection?.apiUrl ?? null,
  )
  const wireApi = stringField(state, {
    path: [...provider, "wire_api"],
    value: "responses",
  })
  if (wireApi !== null && wireApi !== "responses")
    state.conflicts.add([...provider, "wire_api"].join("."))
  addMissing(state, { path: [...provider, "name"], value: "Copilot Proxy" })
  const authenticationPresent = codexAuthentication(state, provider)
  return { model, rootUrl: rootFromApi(apiUrl), apiUrl, authenticationPresent }
}

function opencodeAuthentication(
  state: Inspection,
  provider: Array<string>,
): boolean {
  const path = [...provider, "options", "apiKey"]
  const existingKey = existingString(state.document, path)
  if (state.connection?.authentication.kind === "keyed") {
    if (!existingKey)
      stringField(
        state,
        { path: path, value: state.connection.authentication.key },
        true,
      )
    if (
      existingKey
      && !existingKey.startsWith("{env:")
      && existingKey !== state.connection.authentication.key
    )
      state.conflicts.add(path.join("."))
  }
  return existingKey !== null
}

function addOpenCodeModel(
  state: Inspection,
  provider: Array<string>,
  id: string,
): void {
  if (id.length === 0) return
  const model = state.catalog.find((item) => item.id === id)
  addMissing(
    state,
    { path: [...provider, "models", id, "name"], value: model?.name ?? id },
    true,
  )
  if (model?.contextWindow && model.maxOutput) {
    addMissing(state, {
      path: [...provider, "models", id, "limit", "context"],
      value: model.contextWindow,
    })
    addMissing(state, {
      path: [...provider, "models", id, "limit", "output"],
      value: model.maxOutput,
    })
  }
}

function opencodePlan(state: Inspection, proposal: string | null) {
  const model = modelInformation(state, {
    target: "opencode",
    path: ["model"],
    proposal: proposal,
  })
  const exact =
    model.kind === "configured" ?
      model.exact
    : configuredModelValue("opencode", proposal ?? "")
  const separator = exact.indexOf("/")
  const selectedProvider =
    separator > 0 ? exact.slice(0, separator) : "copilot_proxy"
  const provider = ["provider", selectedProvider]
  const existingUrl = existingString(state.document, [
    ...provider,
    "options",
    "baseURL",
  ])
  if (
    model.kind === "configured"
    && (separator <= 0
      || !isProxyProvider(state, selectedProvider, existingUrl))
  )
    state.conflicts.add("model")
  const apiUrl = endpointField(
    state,
    [...provider, "options", "baseURL"],
    state.connection?.apiUrl ?? null,
  )
  const npm = stringField(
    state,
    { path: [...provider, "npm"], value: "@ai-sdk/openai-compatible" },
    true,
  )
  if (
    npm !== null
    && !["@ai-sdk/openai", "@ai-sdk/openai-compatible"].includes(npm)
  )
    state.conflicts.add([...provider, "npm"].join("."))
  addMissing(state, {
    path: ["$schema"],
    value: "https://opencode.ai/config.json",
  })
  addMissing(state, { path: [...provider, "name"], value: "Copilot Proxy" })
  const id = separator >= 0 ? exact.slice(separator + 1) : exact
  addOpenCodeModel(state, provider, id)
  const authenticationPresent = opencodeAuthentication(state, provider)
  return { model, rootUrl: rootFromApi(apiUrl), apiUrl, authenticationPresent }
}

function planAgent({
  read,
  target,
  connection,
  catalog,
  proposal,
}: {
  read: ConfigRead
  target: ConfigurableAgent
  proposal: string | null
} & Pick<InspectAgentConfigsOptions, "connection" | "catalog">): Plan {
  if (read.kind === "invalid") {
    return {
      view: {
        target,
        path: read.path,
        status: "invalid",
        model: { kind: "missing" },
        rootUrl: null,
        apiUrl: null,
        authenticationPresent: false,
        missingFields: [],
        conflictFields: [],
        message: read.message,
      },
      additions: [],
    }
  }
  const state: Inspection = {
    document: read.file.document,
    connection,
    catalog,
    missing: new Set(),
    conflicts: new Set(),
    additions: [],
  }
  const planners = {
    "claude-code": claudePlan,
    codex: codexPlan,
    opencode: opencodePlan,
  }
  const details = planners[target](state, proposal)
  const missingFields = [...state.missing]
  const conflictFields = [...state.conflicts]
  let status: AgentConfigView["status"] = "configured"
  if (missingFields.length > 0) status = "missing"
  if (conflictFields.length > 0) status = "conflicting"
  return {
    view: {
      target,
      path: read.file.path,
      status,
      ...details,
      missingFields,
      conflictFields,
    },
    additions: state.additions,
  }
}

export async function inspectAgentConfigs(
  options: InspectAgentConfigsOptions,
): Promise<Array<AgentConfigView>> {
  return Promise.all(
    targets.map(
      async (target) =>
        planAgent({
          read: await readAgentConfig(target, options.homeDirectory),
          target: target,
          connection: options.connection,
          catalog: options.catalog,
          proposal: options.proposals[target],
        }).view,
    ),
  )
}

export async function configuredProxyRoots(
  homeDirectory: string,
): Promise<Array<LoopbackRootUrl>> {
  const views = await inspectAgentConfigs({
    homeDirectory,
    connection: null,
    catalog: [],
    proposals: { "claude-code": null, codex: null, opencode: null },
  })
  const roots = new Set<LoopbackRootUrl>()
  for (const view of views) {
    const url = safeUrl(view.rootUrl)
    if (!url || !["", "/"].includes(url.pathname)) continue
    const parsed = loopbackRootUrlSchema.safeParse(url.origin)
    if (parsed.success) roots.add(parsed.data)
  }
  return [...roots]
}

export async function configuredProxyConnections(
  homeDirectory: string,
): Promise<Array<NativeConnection>> {
  const candidates: Array<NativeConnection> = []
  const reads = await Promise.all(
    targets.map(async (target) => ({
      target,
      read: await readAgentConfig(target, homeDirectory),
    })),
  )
  for (const { target, read } of reads) {
    if (read.kind !== "ready") continue
    const view = planAgent({
      read,
      target,
      connection: null,
      catalog: [],
      proposal: null,
    }).view
    const url = safeUrl(view.rootUrl)
    if (!url || !["", "/"].includes(url.pathname)) continue
    const root = loopbackRootUrlSchema.safeParse(url.origin)
    if (!root.success) continue
    const base = { rootUrl: root.data, apiUrl: `${root.data}/v1` }
    candidates.push(
      nativeConnectionSchema.parse({
        ...base,
        authentication: { kind: "none" },
      }),
    )
    for (const key of literalCredentials(target, read.file.document)) {
      candidates.push(
        nativeConnectionSchema.parse({
          ...base,
          authentication: { kind: "keyed", key },
        }),
      )
    }
  }
  const unique = new Map(
    candidates.map((candidate) => [JSON.stringify(candidate), candidate]),
  )
  return [...unique.values()].sort(
    (left, right) =>
      Number(left.authentication.kind === "keyed")
      - Number(right.authentication.kind === "keyed"),
  )
}

function proposalAllowed(options: ConfigureMissingAgentOptions): boolean {
  if (options.proposal === null) return false
  const model = options.catalog.find(
    (item) => item.id === options.proposal?.catalogId,
  )
  if (!model) return false
  if (options.target === "codex") return model.endpoints.includes("/responses")
  if (options.target === "opencode")
    return model.endpoints.includes("/chat/completions")
  return model.endpoints.some(
    (endpoint) => endpoint === "/responses" || endpoint === "/chat/completions",
  )
}

async function configureLocked(
  options: ConfigureMissingAgentOptions,
  lockPath: string,
): Promise<ConfigureResult> {
  const read = await readAgentConfig(options.target, options.homeDirectory)
  const proposal = options.proposal?.catalogId ?? null
  const plan = planAgent({
    read: read,
    target: options.target,
    connection: options.connection,
    catalog: options.catalog,
    proposal: proposal,
  })
  if (plan.view.status === "invalid")
    return {
      kind: "invalid",
      message: plan.view.message ?? invalidSyntax,
      view: plan.view,
    }
  if (read.kind !== "ready" || read.file.resolvedPath !== lockPath)
    return { kind: "conflict", fields: ["file"], view: plan.view }
  if (plan.view.status === "conflicting")
    return {
      kind: "conflict",
      fields: plan.view.conflictFields,
      view: plan.view,
    }
  if (plan.view.status === "configured")
    return { kind: "unchanged", view: plan.view }
  if (
    plan.view.model.kind === "missing"
    || (plan.view.model.kind === "proposed" && !proposalAllowed(options))
  )
    return {
      kind: "invalid",
      message: "Choose an available model for this agent before configuring.",
      view: plan.view,
    }
  const written = await writeConfigAdditions({
    file: read.file,
    additions: plan.additions,
    target: options.target,
    homeDirectory: options.homeDirectory,
  })
  if (written.kind === "invalid") return { ...written, view: plan.view }
  const current = await readAgentConfig(options.target, options.homeDirectory)
  const view = planAgent({
    read: current,
    target: options.target,
    connection: options.connection,
    catalog: options.catalog,
    proposal: proposal,
  }).view
  return written.kind === "changed" ?
      {
        kind: "conflict",
        fields: ["file"],
        view: {
          ...view,
          message:
            "The configuration changed during Configure. Review it and try again.",
        },
      }
    : {
        kind: "added",
        fields: plan.additions.map((addition) => addition.path.join(".")),
        view,
      }
}

export async function configureMissingAgent(
  options: ConfigureMissingAgentOptions,
): Promise<ConfigureResult> {
  const initial = await readAgentConfig(options.target, options.homeDirectory)
  if (initial.kind === "invalid") {
    const view = planAgent({
      read: initial,
      target: options.target,
      connection: options.connection,
      catalog: options.catalog,
      proposal: options.proposal?.catalogId ?? null,
    }).view
    return { kind: "invalid", message: initial.message, view }
  }
  return withConfigWriter(initial.file.resolvedPath, () =>
    configureLocked(options, initial.file.resolvedPath),
  )
}
