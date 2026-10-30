import { Box, Code2, Copy, KeyRound, LockKeyhole, Terminal } from "lucide-react"
import { useState } from "react"

import type { AgentTarget, DesktopSettings } from "../shared/contracts"
import type { ViewProps } from "./App"

import {
  AGENTS,
  createConnectionSnippet,
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

export function AgentsView({ snapshot, run, pending }: ViewProps) {
  const [target, setTarget] = useState<AgentTarget>("claude-code")
  const [modelId, setModelId] = useState(snapshot.settings.preferredModel)
  const [shell, setShell] = useState<DesktopSettings["shell"]>(
    snapshot.settings.shell,
  )
  const models = snapshot.models.filter((model) => supportsAgent(model, target))
  const model =
    models.find((entry) => entry.id === modelId)
    ?? models.find((entry) => entry.id === snapshot.settings.preferredModel)
    ?? models.at(0)
  const agent = AGENTS.find((entry) => entry.id === target)
  const snippet =
    model ?
      createConnectionSnippet({
        target,
        model,
        port: snapshot.settings.port,
        apiKey: "<LOCAL_API_KEY>",
        shell,
      })
    : ""
  const signedIn = snapshot.account.kind === "signed-in"
  const status = gatewayStatus(snapshot.gateway)

  return (
    <div className="view-stack agents-view">
      <div className="view-heading">
        <div>
          <h2>Connect an agent</h2>
          <p>Use your Copilot models in your terminal.</p>
        </div>
        <Badge tone={status.tone} dot>
          {snapshot.gateway.kind === "running" ?
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
          <div className="agent-intro">
            <div>
              <h3>{agent?.name}</h3>
              <span>{agent?.protocol}</span>
            </div>
          </div>
          {snapshot.models.length === 0 && (
            <EmptyState
              icon={Terminal}
              title={
                signedIn ? "No models available" : "Sign in to choose a model"
              }
              action={
                <Button
                  variant="primary"
                  busy={pending.has(signedIn ? "refresh" : "sign-in")}
                  onClick={() => {
                    void run({ kind: signedIn ? "refresh" : "sign-in" })
                  }}
                >
                  {signedIn ? "Refresh models" : "Sign in with GitHub"}
                </Button>
              }
            >
              Your account's model catalog is used to build the configuration.
            </EmptyState>
          )}
          {snapshot.models.length > 0 && models.length === 0 && (
            <EmptyState
              icon={Box}
              title="No compatible models"
              action={
                <Button
                  onClick={() => {
                    void run({ kind: "refresh" })
                  }}
                  busy={pending.has("refresh")}
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
          {models.length > 0 && (
            <>
              <div className="agent-options">
                <ModelSelect
                  id="agent-model"
                  models={models}
                  value={model?.id ?? ""}
                  disabled={pending.has("select-model")}
                  onChange={(value) => {
                    setModelId(value)
                    void run({ kind: "select-model", modelId: value })
                  }}
                />
                <label className="field" htmlFor="agent-shell">
                  <span>Shell</span>
                  <select
                    id="agent-shell"
                    value={shell}
                    disabled={pending.has("save-settings")}
                    onChange={(event) => {
                      const nextShell =
                        event.target.value === "powershell" ?
                          "powershell"
                        : "posix"
                      setShell(nextShell)
                      void run({
                        kind: "save-settings",
                        settings: { ...snapshot.settings, shell: nextShell },
                      })
                    }}
                  >
                    <option value="posix">POSIX shell</option>
                    <option value="powershell">PowerShell</option>
                  </select>
                </label>
              </div>
              {target === "codex" && (
                <p className="compatibility-note">
                  Showing models with Responses API support.
                </p>
              )}
              {target === "opencode" && (
                <p className="compatibility-note">
                  Showing models with Chat Completions support.
                </p>
              )}
              <div className="configuration-preview">
                <div className="code-toolbar">
                  <span>
                    <Terminal size={13} aria-hidden="true" />
                    {shell === "posix" ? "Terminal" : "PowerShell"}
                  </span>
                  <span>
                    <LockKeyhole size={12} aria-hidden="true" />
                    Key hidden in preview
                  </span>
                </div>
                <pre
                  tabIndex={0}
                  aria-label={`${agent?.name} configuration preview`}
                >
                  <code>{snippet}</code>
                </pre>
              </div>
              <div className="configuration-actions">
                <p>
                  <KeyRound size={14} aria-hidden="true" />
                  The copied configuration includes your local key.
                </p>
                <Button
                  data-testid="copy-config"
                  variant="primary"
                  icon={Copy}
                  disabled={!model || !signedIn}
                  busy={pending.has("copy-config")}
                  onClick={() => {
                    if (model)
                      void run(
                        {
                          kind: "copy-config",
                          target,
                          modelId: model.id,
                          shell,
                        },
                        "Configuration copied",
                      )
                  }}
                >
                  Copy configuration
                </Button>
              </div>
              <div className="setup-instruction">
                <span className="instruction-number">1</span>
                <p>
                  {target === "curl" ?
                    "Paste and run this command in your terminal."
                  : `Paste these commands in your terminal to start ${agent?.name}.`
                  }
                </p>
              </div>
              {snapshot.gateway.kind !== "running" && (
                <div className="setup-instruction">
                  <span className="instruction-number">2</span>
                  <p>Start the gateway before sending requests.</p>
                  <Button
                    icon={Terminal}
                    disabled={
                      !signedIn
                      || snapshot.gateway.kind === "starting"
                      || snapshot.gateway.kind === "stopping"
                    }
                    busy={pending.has("start-gateway")}
                    onClick={() => {
                      void run({ kind: "start-gateway" })
                    }}
                  >
                    Start gateway
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </section>
      <p className="footnote">
        <LockKeyhole size={13} aria-hidden="true" />
        These commands do not overwrite your agent configuration files.
      </p>
    </div>
  )
}
