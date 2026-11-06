import {
  Box,
  Code2,
  Copy,
  FolderOpen,
  RefreshCw,
  Terminal,
  Wrench,
} from "lucide-react"
import { useEffect, useState } from "react"

import type {
  AgentConfigView,
  AgentTarget,
  DesktopModel,
} from "../shared/contracts"
import type { ViewProps } from "./App"

import {
  AGENT_DETAILS,
  AGENTS,
  createHttpRequest,
  supportsAgent,
} from "../shared/connections"
import {
  Badge,
  Button,
  EmptyState,
  gatewayStatus,
  ModelSelect,
  nextTabIndex,
} from "./components"

interface Selection {
  config: AgentConfigView | null
  models: Array<DesktopModel>
  model: DesktopModel | null
  modelId: string
}

function selectionFor(
  snapshot: ViewProps["snapshot"],
  target: AgentTarget,
  httpModelId: string,
): Selection {
  const config =
    target === "curl" ? null : (
      (snapshot.agentConfigs.find((view) => view.target === target) ?? null)
    )
  const models = snapshot.models.filter((model) => supportsAgent(model, target))
  let modelId = httpModelId
  if (target !== "curl") {
    modelId = snapshot.settings.agentModelChoices[target] ?? ""
    if (config?.model.kind === "proposed") modelId = config.model.catalogId
    if (config?.model.kind === "configured")
      modelId = config.model.catalogId ?? config.model.exact
  }
  let model = models.find((entry) => entry.id === modelId) ?? null
  if (target === "curl" && model === null) model = models.at(0) ?? null
  return {
    config,
    models,
    model,
    modelId:
      config?.model.kind === "configured" ?
        config.model.exact
      : (model?.id ?? ""),
  }
}

export function AgentsView({ snapshot, run, pending }: ViewProps) {
  const [target, setTarget] = useState<AgentTarget>("claude-code")
  const [httpModelId, setHttpModelId] = useState("")
  useEffect(() => {
    if (target !== "curl") void run({ kind: "inspect-agent-config", target })
  }, [run, target])
  const status = gatewayStatus(snapshot.gateway)
  const selected = selectionFor(snapshot, target, httpModelId)
  return (
    <div className="view-stack agents-view">
      <div className="view-heading">
        <div>
          <h2>Connect an agent</h2>
          <p>Use your Copilot models in your terminal.</p>
        </div>
        <Badge tone={status.tone} dot>
          {snapshot.connection ?
            "Gateway ready"
          : `Gateway ${status.label.toLowerCase()}`}
        </Badge>
      </div>
      <section className="panel agent-panel">
        <div className="agent-tabs" role="tablist" aria-label="Agent">
          {AGENTS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`agent-tab-${entry.id}`}
              aria-controls="agent-setup-content"
              aria-selected={target === entry.id}
              tabIndex={target === entry.id ? 0 : -1}
              className={`agent-tab ${target === entry.id ? "is-active" : ""}`}
              onClick={() => {
                setTarget(entry.id)
              }}
              onKeyDown={(event) => {
                const index = AGENTS.findIndex((value) => value.id === target)
                const nextIndex = nextTabIndex({
                  key: event.key,
                  index,
                  length: AGENTS.length,
                })
                if (nextIndex === null) return
                event.preventDefault()
                const next = AGENTS.at(nextIndex)
                if (next) {
                  setTarget(next.id)
                  document
                    .querySelector<HTMLElement>(`#agent-tab-${next.id}`)
                    ?.focus()
                }
              }}
            >
              {entry.id === "curl" ?
                <Code2 size={16} aria-hidden="true" />
              : <Terminal size={16} aria-hidden="true" />}
              {entry.name}
            </button>
          ))}
        </div>
        <div
          className="agent-setup"
          id="agent-setup-content"
          role="tabpanel"
          aria-labelledby={`agent-tab-${target}`}
        >
          <AgentSetup
            snapshot={snapshot}
            run={run}
            pending={pending}
            target={target}
            selected={selected}
            onHttpModel={setHttpModelId}
          />
        </div>
      </section>
    </div>
  )
}

function configurationBadge(config: AgentConfigView | null) {
  if (!config) return <Badge>Checking configuration</Badge>
  switch (config.status) {
    case "configured": {
      return <Badge tone="success">Configured</Badge>
    }
    case "missing": {
      return <Badge tone="warning">Missing settings</Badge>
    }
    case "conflicting": {
      return <Badge tone="warning">Needs review</Badge>
    }
    case "invalid": {
      return <Badge tone="error">Invalid configuration</Badge>
    }
    default: {
      const exhaustive: never = config.status
      return exhaustive
    }
  }
}

function AgentSetup({
  snapshot,
  run,
  pending,
  target,
  selected,
  onHttpModel,
}: ViewProps & {
  target: AgentTarget
  selected: Selection
  onHttpModel: (modelId: string) => void
}) {
  const { config, models, model, modelId } = selected
  const agent = AGENT_DETAILS[target]
  const ready =
    snapshot.connection !== null && snapshot.gateway.kind === "running"
  const savedModel = config?.model.kind === "configured"
  const canRefresh =
    snapshot.account.kind === "signed-in" || snapshot.connection !== null
  const request =
    target === "curl" && model && snapshot.connection ?
      createHttpRequest({ connection: snapshot.connection, model })
    : null
  const shellLabel =
    snapshot.settings.shell === "posix" ? "Terminal" : "PowerShell"
  const previewLabel = request ? `POST ${request.url}` : shellLabel
  return (
    <>
      <div className="agent-intro">
        <div>
          <h3>{agent.name}</h3>
          <span>{agent.protocol}</span>
        </div>
        {target !== "curl" && configurationBadge(config)}
      </div>
      {snapshot.models.length === 0 && !savedModel && (
        <EmptyState
          icon={Terminal}
          title={
            canRefresh ? "No models available" : "Sign in to choose a model"
          }
          action={
            <Button
              variant="primary"
              busy={pending.has(canRefresh ? "refresh" : "sign-in")}
              onClick={() => {
                void run({ kind: canRefresh ? "refresh" : "sign-in" })
              }}
            >
              {canRefresh ? "Refresh models" : "Sign in with GitHub"}
            </Button>
          }
        >
          Your account's model catalog is used to configure this agent.
        </EmptyState>
      )}
      {snapshot.models.length > 0 && models.length === 0 && !savedModel && (
        <EmptyState
          icon={Box}
          title="No compatible models"
          action={
            <Button
              busy={pending.has("refresh")}
              onClick={() => {
                void run({ kind: "refresh" })
              }}
            >
              Refresh models
            </Button>
          }
        >
          {target === "codex" ?
            "Codex requires a model that supports the Responses API."
          : "This agent requires a model that supports Chat Completions."}
        </EmptyState>
      )}
      {(models.length > 0 || savedModel) && (
        <AgentFields
          snapshot={snapshot}
          run={run}
          pending={pending}
          target={target}
          selected={selected}
          onHttpModel={onHttpModel}
        />
      )}
      {config && (
        <p className="footnote">
          <FolderOpen size={13} aria-hidden="true" />
          <code>{config.path}</code>
        </p>
      )}
      {config?.status === "conflicting" && (
        <p className="compatibility-note" role="alert">
          Review {config.conflictFields.join(", ")} in the existing
          configuration.
          {snapshot.connection && (
            <>
              {" "}
              The running proxy uses{" "}
              {target === "claude-code" ?
                snapshot.connection.rootUrl
              : snapshot.connection.apiUrl}
              .
            </>
          )}
        </p>
      )}
      {config?.status === "invalid" && (
        <p className="compatibility-note" role="alert">
          {config.message}
        </p>
      )}
      {(config?.status === "configured" || request) && (
        <div className="configuration-preview">
          <div className="code-toolbar">
            <span>
              <Terminal size={13} aria-hidden="true" />
              {previewLabel}
            </span>
            {request
              && snapshot.connection?.authentication.kind === "keyed" && (
                <span>Local key added on copy</span>
              )}
          </div>
          <pre tabIndex={0} aria-label={`${agent.name} configuration preview`}>
            <code>
              {request ?
                JSON.stringify(request.payload, null, 2)
              : agent.command}
            </code>
          </pre>
        </div>
      )}
      <div className="configuration-actions">
        <div className="heading-actions">
          {target !== "curl" && config?.status === "missing" && (
            <Button
              data-testid="configure-agent"
              icon={Wrench}
              variant="primary"
              disabled={
                !ready
                || !modelId
                || pending.has("select-agent-model")
                || pending.has("inspect-agent-config")
              }
              busy={pending.has("configure-agent")}
              onClick={() => {
                void run(
                  { kind: "configure-agent", target },
                  "Agent configured",
                )
              }}
            >
              Configure
            </Button>
          )}
          {target !== "curl" && (
            <Button
              data-testid="open-config-folder"
              icon={FolderOpen}
              busy={pending.has("open-config-folder")}
              onClick={() => {
                void run({ kind: "open-config-folder", target })
              }}
            >
              Open configuration folder
            </Button>
          )}
          {target !== "curl" && (
            <Button
              data-testid="inspect-agent-config"
              icon={RefreshCw}
              busy={pending.has("inspect-agent-config")}
              onClick={() => {
                void run({ kind: "inspect-agent-config", target })
              }}
            >
              Check configuration
            </Button>
          )}
        </div>
        {(config?.status === "configured" || target === "curl") && (
          <Button
            data-testid="copy-config"
            icon={Copy}
            variant="primary"
            disabled={!ready || !modelId}
            busy={pending.has("copy-config")}
            onClick={() => {
              if (modelId)
                void run(
                  {
                    kind: "copy-config",
                    target,
                    modelId,
                    shell: snapshot.settings.shell,
                  },
                  target === "curl" ? "Request copied" : (
                    "Launch command copied"
                  ),
                )
            }}
          >
            {target === "curl" ? "Copy request" : "Copy command"}
          </Button>
        )}
      </div>
      {config?.status === "missing" && (
        <p className="footnote">
          Configure adds missing settings and preserves existing values.
        </p>
      )}
      <ConfigureFeedback snapshot={snapshot} target={target} />
      {!ready && (
        <div className="setup-instruction">
          <span className="instruction-number">1</span>
          <p>
            {snapshot.source.kind === "legacy-cli" ?
              "Start the CLI proxy in Terminal before sending requests."
            : "Start the gateway before sending requests."}
          </p>
          {snapshot.source.kind !== "legacy-cli" && (
            <Button
              icon={Terminal}
              disabled={
                snapshot.account.kind !== "signed-in"
                || snapshot.gateway.kind === "starting"
                || snapshot.gateway.kind === "stopping"
                || snapshot.gateway.kind === "draining"
              }
              busy={pending.has("start-gateway")}
              onClick={() => {
                void run({ kind: "start-gateway" })
              }}
            >
              Start gateway
            </Button>
          )}
        </div>
      )}
    </>
  )
}

function AgentFields({
  snapshot,
  run,
  pending,
  target,
  selected,
  onHttpModel,
}: ViewProps & {
  target: AgentTarget
  selected: Selection
  onHttpModel: (modelId: string) => void
}) {
  const { config, models, model } = selected
  const configuredModel =
    config?.model.kind === "configured" ? config.model : null
  const actualUrl =
    target === "claude-code" ?
      snapshot.connection?.rootUrl
    : snapshot.connection?.apiUrl
  const savedUrl = target === "claude-code" ? config?.rootUrl : config?.apiUrl
  return (
    <div className="view-stack">
      <div className="agent-options">
        {configuredModel ?
          <label className="field" htmlFor="agent-model">
            <span>Model</span>
            <input
              id="agent-model"
              data-testid="configured-agent-model"
              readOnly
              value={configuredModel.exact}
            />
          </label>
        : <ModelSelect
            id="agent-model"
            models={models}
            value={model?.id ?? ""}
            disabled={
              pending.has("select-agent-model")
              || pending.has("configure-agent")
              || config?.status === "conflicting"
              || config?.status === "invalid"
            }
            onChange={(value) => {
              if (target === "curl") onHttpModel(value)
              else
                void run({ kind: "select-agent-model", target, modelId: value })
            }}
          />
        }
        <label className="field" htmlFor="agent-shell">
          <span>Shell</span>
          <select
            id="agent-shell"
            value={snapshot.settings.shell}
            disabled={pending.has("save-settings")}
            onChange={(event) => {
              const shell =
                event.target.value === "powershell" ? "powershell" : "posix"
              void run({
                kind: "save-settings",
                settings: { ...snapshot.settings, shell },
              })
            }}
          >
            <option value="posix">POSIX shell</option>
            <option value="powershell">PowerShell</option>
          </select>
        </label>
      </div>
      <label className="field" htmlFor="agent-url">
        <span>Proxy URL</span>
        <input
          id="agent-url"
          data-testid="agent-proxy-url"
          readOnly
          value={savedUrl ?? actualUrl ?? ""}
          placeholder="Start the gateway to configure"
        />
      </label>
    </div>
  )
}

function ConfigureFeedback({
  snapshot,
  target,
}: Pick<ViewProps, "snapshot"> & { target: AgentTarget }) {
  const result = snapshot.lastConfigureResult
  if (!result || result.view.target !== target) return null
  let message: string
  switch (result.kind) {
    case "added": {
      message = "Missing settings added."
      break
    }
    case "unchanged": {
      message = "Configuration is already complete."
      break
    }
    case "conflict": {
      message =
        result.view.message
        ?? "Configure preserved the existing settings. Review the conflicting fields."
      break
    }
    case "invalid": {
      message = result.message
      break
    }
    default: {
      const exhaustive: never = result
      return exhaustive
    }
  }
  return (
    <p
      className="compatibility-note"
      role={
        result.kind === "conflict" || result.kind === "invalid" ?
          "alert"
        : "status"
      }
    >
      {message}
    </p>
  )
}
