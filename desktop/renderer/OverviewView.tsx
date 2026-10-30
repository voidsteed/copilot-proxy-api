import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  Copy,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Network,
  Play,
  RefreshCw,
  Send,
  Square,
  Terminal,
  TriangleAlert,
} from "lucide-react"
import { useState } from "react"

import type { ViewProps } from "./App"

import { RequestTable } from "./ActivityView"
import {
  Badge,
  Button,
  EmptyState,
  formatDate,
  formatDuration,
  formatNumber,
  formatTime,
  gatewayStatus,
  ModelSelect,
} from "./components"
import { Github } from "./Github"

interface OverviewProps extends ViewProps {
  testRequest: { open: boolean; modelId: string }
  onTestToggle: (open: boolean) => void
  onNavigate: (
    view: "agents" | "activity" | "models" | "settings" | "overview",
  ) => void
}

export function OverviewView({
  snapshot,
  run,
  pending,
  testRequest,
  onTestToggle,
  onNavigate,
}: OverviewProps) {
  const { account, gateway } = snapshot
  const signedIn = account.kind === "signed-in"
  const running = gateway.kind === "running"
  const starting = gateway.kind === "starting"
  const stopping = gateway.kind === "stopping"
  const canStop = running || starting
  let gatewayAction = "Start gateway"
  if (stopping) gatewayAction = "Stopping…"
  else if (canStop) gatewayAction = "Stop gateway"
  const status = gatewayStatus(gateway)
  const endpoint =
    running ? gateway.url : `http://127.0.0.1:${snapshot.settings.port}/v1`
  const recent = snapshot.activity.slice(0, 5)

  return (
    <div className="view-stack overview-view">
      <section className="panel connection-panel">
        <div className="panel-heading connection-heading">
          <h2>Connection</h2>
          <div className="button-group">
            <Button
              data-testid="open-probe"
              icon={Send}
              onClick={() => {
                onTestToggle(!testRequest.open)
              }}
              aria-expanded={testRequest.open}
              aria-controls="test-request-panel"
            >
              Test request
            </Button>
            <Button
              variant={canStop ? "secondary" : "primary"}
              icon={canStop ? Square : Play}
              data-testid={canStop ? "stop-gateway" : "start-gateway"}
              disabled={!signedIn || stopping}
              busy={
                canStop ?
                  pending.has("stop-gateway")
                : pending.has("start-gateway") || stopping
              }
              onClick={() => {
                void run({ kind: canStop ? "stop-gateway" : "start-gateway" })
              }}
            >
              {gatewayAction}
            </Button>
          </div>
        </div>

        <div className={`connection-path ${running ? "is-running" : ""}`}>
          <div className="connection-node provider-node">
            <div className="node-icon provider-icon">
              <Github size={24} strokeWidth={1.6} aria-hidden="true" />
              {signedIn && (
                <span className="node-check">
                  <Check size={9} strokeWidth={3} />
                </span>
              )}
            </div>
            <strong>GitHub Copilot</strong>
            {signedIn ?
              <>
                <span className="node-detail">@{account.login}</span>
                <Badge tone="success">Connected</Badge>
              </>
            : <>
                <span className="node-detail">No account connected</span>
                <Button
                  variant="secondary"
                  icon={Github}
                  busy={pending.has("sign-in") || account.kind === "connecting"}
                  disabled={account.kind === "awaiting-authorization"}
                  onClick={() => {
                    void run({ kind: "sign-in" })
                  }}
                >
                  Sign in with GitHub
                </Button>
              </>
            }
          </div>
          <div
            className={`connection-line ${signedIn ? "is-connected" : ""}`}
            aria-hidden="true"
          >
            <span />
            <ArrowRight size={15} />
          </div>
          <div
            className={`connection-node gateway-node ${running ? "is-running" : ""}`}
          >
            <div className="node-icon gateway-icon">
              {starting || stopping ?
                <LoaderCircle
                  size={25}
                  className="spin"
                  strokeWidth={1.6}
                  aria-hidden="true"
                />
              : <Network size={25} strokeWidth={1.6} aria-hidden="true" />}
            </div>
            <strong>Local gateway</strong>
            <code className="node-detail">
              127.0.0.1:{snapshot.settings.port}
            </code>
            <Badge tone={status.tone} dot>
              {status.label}
            </Badge>
          </div>
          <div
            className={`connection-line ${running ? "is-connected" : ""}`}
            aria-hidden="true"
          >
            <span />
            <ArrowRight size={15} />
          </div>
          <div className="connection-node agents-node">
            <div className="node-icon agents-icon">
              <Terminal size={24} strokeWidth={1.6} aria-hidden="true" />
            </div>
            <strong>Your agents</strong>
            <span className="node-detail">Claude Code, Codex, OpenCode</span>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                onNavigate("agents")
              }}
            >
              Set up an agent
              <ArrowUpRight size={13} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="endpoint-bar">
          <div className="endpoint-address">
            <LockKeyhole size={15} aria-hidden="true" />
            <code title={endpoint}>{endpoint}</code>
          </div>
          <div className="endpoint-actions">
            <Button
              icon={Copy}
              variant="ghost"
              onClick={() => {
                void run(
                  { kind: "copy", target: "base-url" },
                  "Endpoint copied",
                )
              }}
            >
              Copy URL
            </Button>
            <span className="endpoint-divider" />
            <Button
              icon={KeyRound}
              variant="ghost"
              disabled={!signedIn}
              onClick={() => {
                void run(
                  { kind: "copy", target: "gateway-key" },
                  "Local key copied",
                )
              }}
            >
              Copy key
            </Button>
          </div>
        </div>
        {gateway.kind === "error" && (
          <div className="connection-error" role="alert">
            <TriangleAlert size={16} aria-hidden="true" />
            <span>{gateway.message}</span>
            <Button
              variant="ghost"
              onClick={() => {
                onNavigate("settings")
              }}
            >
              Settings
            </Button>
          </div>
        )}
      </section>

      {testRequest.open && (
        <TestRequestPanel
          key={testRequest.modelId}
          snapshot={snapshot}
          run={run}
          pending={pending}
          initialModelId={testRequest.modelId}
          onClose={() => {
            onTestToggle(false)
          }}
        />
      )}

      <section
        className="session-metrics"
        aria-label="Current session statistics"
      >
        <div>
          <span>Requests</span>
          <strong>{formatNumber(snapshot.totals.requests)}</strong>
          <small>This session</small>
        </div>
        <div>
          <span>Input tokens</span>
          <strong>{formatNumber(snapshot.totals.inputTokens)}</strong>
          <small>{formatNumber(snapshot.totals.cachedTokens)} cached</small>
        </div>
        <div>
          <span>Output tokens</span>
          <strong>{formatNumber(snapshot.totals.outputTokens)}</strong>
          <small>This session</small>
        </div>
        <div>
          <span>Errors</span>
          <strong
            className={snapshot.totals.errors > 0 ? "error-number" : undefined}
          >
            {formatNumber(snapshot.totals.errors)}
          </strong>
          <small>This session</small>
        </div>
      </section>

      <div className="overview-lower">
        <section className="panel recent-panel">
          <div className="panel-heading">
            <h2>Recent requests</h2>
            <button
              className="text-button"
              type="button"
              onClick={() => {
                onNavigate("activity")
              }}
            >
              View all
              <ArrowUpRight size={13} aria-hidden="true" />
            </button>
          </div>
          {recent.length > 0 ?
            <RequestTable records={recent} compact />
          : <EmptyState
              icon={Activity}
              title="No requests yet"
              action={
                <Button
                  variant="ghost"
                  icon={Send}
                  onClick={() => {
                    onTestToggle(true)
                  }}
                >
                  Send a test request
                </Button>
              }
            >
              Connect an agent or test the gateway.
            </EmptyState>
          }
        </section>
        <UsagePanel snapshot={snapshot} run={run} pending={pending} />
      </div>
      <div className="overview-footer">
        <LockKeyhole size={12} aria-hidden="true" />
        <span>
          Gateway binds to your computer only. Requests require your local key.
        </span>
      </div>
    </div>
  )
}

function UsagePanel({ snapshot, run, pending }: ViewProps) {
  const usage = snapshot.usage
  const quota =
    usage?.quotas.find(
      (entry) => /premium/i.test(entry.id) || /premium/i.test(entry.label),
    ) ?? usage?.quotas[0]
  const signedIn = snapshot.account.kind === "signed-in"

  return (
    <section className="panel usage-panel">
      <div className="panel-heading">
        <h2>{quota?.label ?? "Premium allowance"}</h2>
        <Button
          variant="ghost"
          className="icon-button"
          icon={RefreshCw}
          aria-label="Refresh usage"
          disabled={!signedIn}
          busy={pending.has("refresh")}
          onClick={() => {
            void run({ kind: "refresh" })
          }}
        />
      </div>
      <div className="usage-content">
        {!quota && (
          <>
            <strong className="usage-unavailable">Unavailable</strong>
            <p>
              {signedIn ?
                "Refresh to check your Copilot allowance."
              : "Sign in to see your Copilot allowance."}
            </p>
          </>
        )}
        {quota?.kind === "unlimited" && (
          <>
            <div className="quota-value">Unlimited</div>
            <p>{usage?.plan || "GitHub Copilot"}</p>
          </>
        )}
        {quota?.kind === "limited" && (
          <>
            <div className="quota-value">
              {formatNumber(quota.remaining)}
              <span> / {formatNumber(quota.limit)}</span>
            </div>
            <p>requests remaining</p>
            <div
              className={`quota-meter ${quota.percentRemaining <= 10 ? "is-low" : ""}`}
              role="meter"
              aria-label={`${quota.label} remaining`}
              aria-valuenow={quota.percentRemaining}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <span style={{ width: `${quota.percentRemaining}%` }} />
            </div>
            <div className="quota-summary">
              <span>{quota.percentRemaining.toFixed(0)}% remaining</span>
              {usage?.resetAt && (
                <span>Resets {formatDate(usage.resetAt)}</span>
              )}
            </div>
          </>
        )}
        {usage && (
          <div className="usage-fetched">
            Updated {formatTime(usage.fetchedAt)}
          </div>
        )}
      </div>
    </section>
  )
}

function TestRequestPanel({
  snapshot,
  run,
  pending,
  initialModelId,
  onClose,
}: ViewProps & { initialModelId: string; onClose: () => void }) {
  const [modelId, setModelId] = useState(
    initialModelId || snapshot.settings.preferredModel,
  )
  const [prompt, setPrompt] = useState("Say hello in one short sentence.")
  const selectedModel =
    snapshot.models.find((model) => model.id === modelId)
    ?? snapshot.models.find(
      (model) => model.id === snapshot.settings.preferredModel,
    )
    ?? snapshot.models.at(0)
  const running = snapshot.probe.kind === "running" || pending.has("run-probe")
  const enabled =
    snapshot.gateway.kind === "running"
    && snapshot.account.kind === "signed-in"
    && Boolean(selectedModel)
    && Boolean(prompt.trim())
    && prompt.length <= 4000

  return (
    <section className="panel test-panel" id="test-request-panel">
      <div className="panel-heading">
        <h2>
          <Send size={16} aria-hidden="true" />
          Test request
        </h2>
        <Button
          icon={ChevronDown}
          variant="ghost"
          className="icon-button"
          aria-label="Close test request"
          onClick={onClose}
        />
      </div>
      <form
        className="test-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (enabled && selectedModel)
            void run({
              kind: "run-probe",
              modelId: selectedModel.id,
              prompt: prompt.trim(),
            })
        }}
      >
        <ModelSelect
          id="probe-model"
          models={snapshot.models}
          value={selectedModel?.id ?? ""}
          onChange={setModelId}
          disabled={running}
        />
        <label className="field" htmlFor="probe-prompt">
          <span>Prompt</span>
          <textarea
            id="probe-prompt"
            data-testid="probe-prompt"
            value={prompt}
            maxLength={4000}
            rows={2}
            onChange={(event) => {
              setPrompt(event.target.value)
            }}
            disabled={running}
          />
        </label>
        <div className="test-actions">
          <span className="muted">
            {snapshot.gateway.kind !== "running" ?
              "Start the gateway to send a request."
            : "Uses your Copilot allowance."}
          </span>
          <Button
            type="submit"
            data-testid="probe-send"
            variant="primary"
            icon={Send}
            disabled={!enabled}
            busy={running}
          >
            Send request
          </Button>
        </div>
      </form>
      {snapshot.probe.kind === "running" && (
        <div className="probe-pending" role="status">
          <LoaderCircle size={16} className="spin" aria-hidden="true" />
          Sending to {snapshot.probe.model}…
        </div>
      )}
      {snapshot.probe.kind === "complete" && (
        <div className="probe-result" role="status">
          <div>
            <strong>
              <Check size={14} aria-hidden="true" />
              Response
            </strong>
            <span>
              {snapshot.probe.model}
              <span className="result-duration">
                {formatDuration(snapshot.probe.durationMs)}
              </span>
            </span>
          </div>
          <pre>
            {snapshot.probe.text || "The model returned an empty response."}
          </pre>
        </div>
      )}
      {snapshot.probe.kind === "error" && (
        <div className="probe-error" role="alert">
          <TriangleAlert size={16} aria-hidden="true" />
          <p>{snapshot.probe.message}</p>
        </div>
      )}
    </section>
  )
}
