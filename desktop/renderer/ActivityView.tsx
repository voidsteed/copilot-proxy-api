import { Activity, ChevronRight, Search, Trash2 } from "lucide-react"
import { Fragment, useState } from "react"

import type { ActivityRecord } from "../shared/contracts"
import type { ViewProps } from "./App"

import {
  type BadgeTone,
  Badge,
  Button,
  EmptyState,
  formatDuration,
  formatNumber,
  formatTime,
  formatTokens,
} from "./components"

const outcomeTones: Record<ActivityRecord["outcome"], BadgeTone> = {
  completed: "success",
  failed: "error",
  cancelled: "warning",
}

function statusLabel(record: ActivityRecord): string | number {
  if (record.outcome === "cancelled") return "Cancelled"
  return record.status > 0 ? record.status : "Failed"
}

export function ActivityView({
  snapshot,
  run,
  pending,
  onTest,
}: ViewProps & { onTest: () => void }) {
  const [modelFilter, setModelFilter] = useState("")
  const [outcomeFilter, setOutcomeFilter] = useState("")
  const models = Array.from(
    new Set(
      snapshot.activity.flatMap((record) =>
        record.model ? [record.model] : [],
      ),
    ),
  ).sort()
  const filtered = snapshot.activity.filter(
    (record) =>
      (!modelFilter || record.model === modelFilter)
      && (!outcomeFilter || record.outcome === outcomeFilter),
  )

  return (
    <div className="view-stack">
      <div className="view-heading">
        <div>
          <h2>Session activity</h2>
          <p>{formatNumber(snapshot.totals.requests)} requests this session</p>
        </div>
        <Button
          data-testid="clear-activity"
          icon={Trash2}
          disabled={snapshot.activity.length === 0}
          busy={pending.has("clear-activity")}
          onClick={() => {
            void run({ kind: "clear-activity" }, "Activity cleared")
          }}
        >
          Clear activity
        </Button>
      </div>
      <section className="panel activity-panel">
        <div className="table-toolbar">
          <div className="toolbar-filters">
            <label className="sr-only" htmlFor="activity-model-filter">
              Filter activity by model
            </label>
            <select
              id="activity-model-filter"
              value={modelFilter}
              onChange={(event) => {
                setModelFilter(event.target.value)
              }}
            >
              <option value="">All models</option>
              {models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor="activity-status-filter">
              Filter activity by status
            </label>
            <select
              id="activity-status-filter"
              value={outcomeFilter}
              onChange={(event) => {
                setOutcomeFilter(event.target.value)
              }}
            >
              <option value="">All statuses</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
          <span className="muted table-count">
            {formatNumber(filtered.length)}{" "}
            {filtered.length === 1 ? "request" : "requests"}
          </span>
        </div>
        {snapshot.activity.length === 0 && (
          <EmptyState
            icon={Activity}
            title="No requests yet"
            action={<Button onClick={onTest}>Send a test request</Button>}
          >
            Completed requests appear here while Copilot Bridge is open.
          </EmptyState>
        )}
        {snapshot.activity.length > 0 && filtered.length === 0 && (
          <EmptyState
            icon={Search}
            title="No matching requests"
            action={
              <Button
                onClick={() => {
                  setModelFilter("")
                  setOutcomeFilter("")
                }}
              >
                Clear filters
              </Button>
            }
          >
            Try another model or status.
          </EmptyState>
        )}
        {filtered.length > 0 && <RequestTable records={filtered} />}
      </section>
      <p className="footnote">
        Session history stores request metadata. Prompts and responses are not
        saved.
      </p>
    </div>
  )
}

export function RequestTable({
  records,
  compact = false,
}: {
  records: Array<ActivityRecord>
  compact?: boolean
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)

  return (
    <div className="table-scroll">
      <table className={`request-table ${compact ? "is-compact" : ""}`}>
        <thead>
          <tr>
            <th>Time</th>
            <th>Model</th>
            {!compact && <th>Endpoint</th>}
            <th>Status</th>
            <th className="numeric">Tokens</th>
            <th className="numeric">Duration</th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => {
            const expanded = record.id === expandedId
            const totalTokens =
              record.inputTokens !== null && record.outputTokens !== null ?
                record.inputTokens + record.outputTokens
              : null
            return (
              <Fragment key={record.id}>
                <tr className={expanded ? "expanded-row" : undefined}>
                  <td>
                    <button
                      className="request-expander"
                      type="button"
                      aria-label={`${expanded ? "Hide" : "Show"} request details ${record.id}`}
                      aria-expanded={expanded}
                      onClick={() => {
                        setExpandedId(expanded ? null : record.id)
                      }}
                    >
                      <ChevronRight
                        size={13}
                        className={expanded ? "rotate-down" : undefined}
                        aria-hidden="true"
                      />
                      <time
                        dateTime={record.startedAt}
                        title={new Date(record.startedAt).toLocaleString()}
                      >
                        {formatTime(record.startedAt)}
                      </time>
                    </button>
                  </td>
                  <td>
                    <span
                      className="model-cell"
                      title={record.model ?? undefined}
                    >
                      {record.model ?? "Unknown model"}
                    </span>
                  </td>
                  {!compact && (
                    <td>
                      <code className="endpoint-cell" title={record.path}>
                        {record.path}
                      </code>
                    </td>
                  )}
                  <td>
                    <Badge tone={outcomeTones[record.outcome]}>
                      {statusLabel(record)}
                    </Badge>
                  </td>
                  <td className="numeric tabular">
                    {formatTokens(totalTokens)}
                  </td>
                  <td className="numeric tabular muted">
                    {formatDuration(record.durationMs)}
                  </td>
                </tr>
                {expanded && (
                  <tr className="request-detail-row">
                    <td colSpan={compact ? 5 : 6}>
                      <dl className="request-details">
                        <div className="detail-wide">
                          <dt>Request ID</dt>
                          <dd>
                            <code>{record.id}</code>
                          </dd>
                        </div>
                        <div>
                          <dt>Endpoint</dt>
                          <dd>
                            <code>
                              {record.method} {record.path}
                            </code>
                          </dd>
                        </div>
                        <div>
                          <dt>Outcome</dt>
                          <dd className="capitalize">{record.outcome}</dd>
                        </div>
                        <div>
                          <dt>HTTP status</dt>
                          <dd>
                            {record.status > 0 ? record.status : "No response"}
                          </dd>
                        </div>
                        <div>
                          <dt>Input tokens</dt>
                          <dd>{formatTokens(record.inputTokens)}</dd>
                        </div>
                        <div>
                          <dt>Output tokens</dt>
                          <dd>{formatTokens(record.outputTokens)}</dd>
                        </div>
                        <div>
                          <dt>Cached tokens</dt>
                          <dd>{formatTokens(record.cachedTokens)}</dd>
                        </div>
                        <div>
                          <dt>Duration</dt>
                          <dd>{formatDuration(record.durationMs)}</dd>
                        </div>
                        <div className="detail-wide">
                          <dt>Started</dt>
                          <dd>{new Date(record.startedAt).toLocaleString()}</dd>
                        </div>
                      </dl>
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
