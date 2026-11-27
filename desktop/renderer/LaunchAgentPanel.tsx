import { Box, Copy, FolderOpen, RefreshCw, Terminal } from "lucide-react"

import type {
  DesktopModel,
  LaunchAgentDiagnostics,
  LaunchConfiguredAgent,
} from "../shared/contracts"
import type { ViewProps } from "./App"

import {
  AGENT_DETAILS,
  connectionOrigin,
  createLaunchPreview,
} from "../shared/connections"
import { Badge, Button, EmptyState, ModelSelect } from "./components"

export interface LaunchSelection {
  diagnostics: LaunchAgentDiagnostics | null
  models: Array<DesktopModel>
  model: DesktopModel | null
}

function launchDiagnosticsBadge(
  diagnostics: LaunchAgentDiagnostics | null,
  ready: boolean,
  hasModel: boolean,
) {
  if (diagnostics?.kind === "warning" || diagnostics?.kind === "invalid-file") {
    return <Badge tone="warning">Check settings</Badge>
  }
  return (
    <Badge tone={ready && hasModel ? "success" : "neutral"}>
      Session command
    </Badge>
  )
}

export function GatewayStartInstruction({ snapshot, run, pending }: ViewProps) {
  return (
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
  )
}

function LaunchDiagnosticsNote({
  diagnostics,
}: {
  diagnostics: LaunchAgentDiagnostics | null
}) {
  if (!diagnostics) {
    return (
      <p className="compatibility-note" data-testid="launch-agent-diagnostics">
        Antigravity CLI settings are never modified. The session command
        overrides only the launched process.
      </p>
    )
  }
  let message: string
  switch (diagnostics.kind) {
    case "absent": {
      message =
        "No Antigravity CLI settings file was found. Copilot Proxy never creates or modifies settings.json; the session command configures only the launched process."
      break
    }
    case "compatible": {
      message = diagnostics.summary
      break
    }
    case "warning":
    case "invalid-file": {
      message = diagnostics.message
      break
    }
    default: {
      const exhaustive: never = diagnostics
      return exhaustive
    }
  }
  const isAlert =
    diagnostics.kind === "warning" || diagnostics.kind === "invalid-file"
  return (
    <>
      <p className="footnote">
        <FolderOpen size={13} aria-hidden="true" />
        <code>{diagnostics.path}</code>
      </p>
      <p
        className="compatibility-note"
        data-testid="launch-agent-diagnostics"
        role={isAlert ? "alert" : undefined}
      >
        {message}
      </p>
    </>
  )
}

export function LaunchAgentPanel({
  snapshot,
  run,
  pending,
  target,
  selected,
  emptyMessage,
}: ViewProps & {
  target: LaunchConfiguredAgent
  selected: LaunchSelection
  emptyMessage: string
}) {
  const { diagnostics, models, model } = selected
  const agent = AGENT_DETAILS[target]
  const ready =
    snapshot.connection !== null && snapshot.gateway.kind === "running"
  const canRefresh =
    snapshot.account.kind === "signed-in" || snapshot.connection !== null
  const shellLabel =
    snapshot.settings.shell === "posix" ? "Terminal" : "PowerShell"
  const preview =
    snapshot.connection && model ?
      createLaunchPreview({
        target,
        connection: snapshot.connection,
        model,
        shell: snapshot.settings.shell,
      })
    : null
  return (
    <>
      <div className="agent-intro">
        <div>
          <h3>{agent.name}</h3>
          <span>{agent.protocol}</span>
        </div>
        {launchDiagnosticsBadge(diagnostics, ready, model !== null)}
      </div>
      {snapshot.models.length === 0 && (
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
      {snapshot.models.length > 0 && models.length === 0 && (
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
          {emptyMessage}
        </EmptyState>
      )}
      {models.length > 0 && (
        <div className="view-stack">
          <div className="agent-options">
            <ModelSelect
              id="agent-model"
              models={models}
              value={model?.id ?? ""}
              disabled={pending.has("select-agent-model")}
              onChange={(value) => {
                void run({
                  kind: "select-agent-model",
                  target,
                  modelId: value,
                })
              }}
            />
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
                    settings: { shell },
                  })
                }}
              >
                <option value="posix">POSIX shell</option>
                <option value="powershell">PowerShell</option>
              </select>
            </label>
          </div>
          <label className="field" htmlFor="agent-url">
            <span>Proxy base URL</span>
            <input
              id="agent-url"
              data-testid="agent-proxy-url"
              readOnly
              value={
                snapshot.connection ? connectionOrigin(snapshot.connection) : ""
              }
              placeholder="Start the gateway to connect"
            />
          </label>
        </div>
      )}
      <LaunchDiagnosticsNote diagnostics={diagnostics} />
      {preview && (
        <div className="configuration-preview">
          <div className="code-toolbar">
            <span>
              <Terminal size={13} aria-hidden="true" />
              {shellLabel}
            </span>
            {snapshot.connection?.authentication.kind === "keyed" && (
              <span>Local key added on copy</span>
            )}
          </div>
          <pre tabIndex={0} aria-label={`${agent.name} configuration preview`}>
            <code>{preview}</code>
          </pre>
        </div>
      )}
      <div className="configuration-actions">
        <div className="heading-actions">
          <Button
            data-testid="inspect-launch-agent"
            icon={RefreshCw}
            busy={pending.has("inspect-launch-agent")}
            onClick={() => {
              void run({ kind: "inspect-launch-agent", target })
            }}
          >
            Check settings
          </Button>
        </div>
        <Button
          data-testid="copy-config"
          icon={Copy}
          variant="primary"
          disabled={!ready || model === null}
          busy={pending.has("copy-config")}
          onClick={() => {
            if (model) {
              void run(
                {
                  kind: "copy-config",
                  target,
                  modelId: model.id,
                  shell: snapshot.settings.shell,
                },
                "Launch command copied",
              )
            }
          }}
        >
          Copy command
        </Button>
      </div>
      {!ready && (
        <GatewayStartInstruction
          snapshot={snapshot}
          run={run}
          pending={pending}
        />
      )}
    </>
  )
}
