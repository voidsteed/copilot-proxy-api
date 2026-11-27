import {
  Box,
  Eye,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Wrench,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react"
import { useState } from "react"

import type { DesktopModel } from "../shared/contracts"
import type { ViewProps } from "./App"

import {
  Badge,
  Button,
  EmptyState,
  formatLimit,
  formatDateTime,
} from "./components"

const capabilities: Array<{
  id: DesktopModel["supports"][number]
  label: string
  icon: LucideIcon
}> = [
  { id: "tools", label: "Tools", icon: Wrench },
  { id: "vision", label: "Vision", icon: Eye },
  { id: "reasoning", label: "Reasoning", icon: Sparkles },
  { id: "streaming", label: "Streaming", icon: Zap },
]

export function filterCatalogModels(
  models: ReadonlyArray<DesktopModel>,
  filters: {
    query: string
    vendor: string
    feature: DesktopModel["supports"][number] | ""
  },
) {
  const vendors = Array.from(
    new Set(models.map((model) => model.vendor)),
  ).sort()
  const activeVendor = vendors.includes(filters.vendor) ? filters.vendor : ""
  const search = filters.query.trim().toLowerCase()
  const matching = models.filter(
    (model) =>
      (!search
        || `${model.id} ${model.name} ${model.vendor}`
          .toLowerCase()
          .includes(search))
      && (!activeVendor || model.vendor === activeVendor)
      && (!filters.feature || model.supports.includes(filters.feature)),
  )
  return {
    vendors,
    activeVendor,
    models: matching,
    filtered:
      Boolean(filters.query)
      || Boolean(activeVendor)
      || Boolean(filters.feature),
  }
}

export function ModelsView({
  snapshot,
  run,
  pending,
  onProbe,
}: ViewProps & {
  onProbe: (modelId: string) => void
}) {
  const [query, setQuery] = useState("")
  const [vendor, setVendor] = useState("")
  const [feature, setFeature] = useState<DesktopModel["supports"][number] | "">(
    "",
  )
  const { vendors, activeVendor, models, filtered } = filterCatalogModels(
    snapshot.models,
    { query, vendor, feature },
  )
  const signedIn = snapshot.account.kind === "signed-in"
  const canRefresh = signedIn || snapshot.connection !== null
  const signInInProgress =
    snapshot.authorization.kind === "connecting"
    || snapshot.authorization.kind === "awaiting"
    || snapshot.authorization.kind === "validating"
    || snapshot.account.kind === "connecting"
    || snapshot.account.kind === "awaiting-authorization"

  return (
    <div className="view-stack">
      <div className="view-heading">
        <div>
          <h2>Model catalog</h2>
          <p>
            {snapshot.models.length}{" "}
            {snapshot.models.length === 1 ? "model" : "models"} from your
            Copilot account
          </p>
        </div>
        <div className="heading-actions">
          {snapshot.modelsFetchedAt && (
            <span className="muted fetched-at" title={snapshot.modelsFetchedAt}>
              Checked {formatDateTime(snapshot.modelsFetchedAt)}
            </span>
          )}
          <Button
            icon={RefreshCw}
            disabled={!canRefresh}
            busy={pending.has("refresh")}
            onClick={() => {
              void run({ kind: "refresh" })
            }}
          >
            Refresh
          </Button>
        </div>
      </div>
      <section className="panel models-panel">
        <div className="table-toolbar model-toolbar">
          <label className="search-input" htmlFor="model-search">
            <Search size={16} aria-hidden="true" />
            <input
              id="model-search"
              data-testid="model-search"
              type="search"
              placeholder="Search models"
              aria-label="Search models"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
              }}
            />
            {query && (
              <button
                type="button"
                aria-label="Clear model search"
                onClick={() => {
                  setQuery("")
                }}
              >
                <X size={13} />
              </button>
            )}
          </label>
          <div className="toolbar-filters">
            <label className="sr-only" htmlFor="vendor-filter">
              Filter by provider
            </label>
            <select
              id="vendor-filter"
              value={activeVendor}
              onChange={(event) => {
                setVendor(event.target.value)
              }}
            >
              <option value="">All providers</option>
              {vendors.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor="feature-filter">
              Filter by capability
            </label>
            <select
              id="feature-filter"
              value={feature}
              onChange={(event) => {
                setFeature(
                  capabilities.find((entry) => entry.id === event.target.value)
                    ?.id ?? "",
                )
              }}
            >
              <option value="">All capabilities</option>
              {capabilities.map((value) => (
                <option key={value.id} value={value.id}>
                  {value.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        {snapshot.models.length === 0 && (
          <EmptyState
            icon={Box}
            title={
              canRefresh ?
                "No models available"
              : "Connect your Copilot account"
            }
            action={
              <Button
                variant="primary"
                disabled={!canRefresh && signInInProgress}
                busy={pending.has(canRefresh ? "refresh" : "sign-in")}
                onClick={() => {
                  void run({ kind: canRefresh ? "refresh" : "sign-in" })
                }}
              >
                {canRefresh ? "Refresh models" : "Sign in with GitHub"}
              </Button>
            }
          >
            {canRefresh ?
              "Refresh the catalog to load the models available to your account."
            : "Your available models will appear here after sign-in."}
          </EmptyState>
        )}
        {snapshot.models.length > 0 && models.length === 0 && (
          <EmptyState
            icon={Search}
            title="No matching models"
            action={
              <Button
                onClick={() => {
                  setQuery("")
                  setVendor("")
                  setFeature("")
                }}
              >
                Clear filters
              </Button>
            }
          >
            Try another name, provider, or capability.
          </EmptyState>
        )}
        {models.length > 0 && (
          <div className="table-scroll">
            <table className="model-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Capabilities</th>
                  <th className="numeric">Context</th>
                  <th className="numeric">Output</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {models.map((model) => {
                  return (
                    <tr key={model.id}>
                      <td>
                        <div className="catalog-model">
                          <span className="vendor-mark" aria-hidden="true">
                            {(model.vendor || model.name)
                              .slice(0, 1)
                              .toUpperCase()}
                          </span>
                          <div>
                            <div
                              className="catalog-model-name"
                              title={model.id}
                            >
                              {model.name}
                              {model.preview && <Badge>Preview</Badge>}
                            </div>
                            <span className="catalog-vendor">
                              {model.vendor || "Unknown provider"}
                            </span>
                          </div>
                        </div>
                      </td>
                      <td>
                        <div className="capabilities">
                          {capabilities
                            .filter((value) =>
                              model.supports.includes(value.id),
                            )
                            .map(({ id, label, icon: Icon }) => (
                              <span key={id} className="capability">
                                <Icon size={11} aria-hidden="true" />
                                {label}
                              </span>
                            ))}
                          {model.supports.length === 0 && (
                            <span className="muted">No details</span>
                          )}
                        </div>
                      </td>
                      <td
                        className="numeric tabular"
                        title={model.contextWindow?.toLocaleString()}
                      >
                        {formatLimit(model.contextWindow)}
                      </td>
                      <td
                        className="numeric tabular"
                        title={model.maxOutput?.toLocaleString()}
                      >
                        {formatLimit(model.maxOutput)}
                      </td>
                      <td>
                        <div className="model-actions">
                          <Button
                            className="icon-button"
                            variant="ghost"
                            icon={Send}
                            aria-label={`Test ${model.name}`}
                            title={`Test ${model.name}`}
                            onClick={() => {
                              onProbe(model.id)
                            }}
                          />
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {snapshot.models.length > 0 && (
          <div className="table-footer">
            <span>
              {models.length} {filtered ? `of ${snapshot.models.length} ` : ""}
              {models.length === 1 ? "model" : "models"}
            </span>
            <span>Limits are tokens per request</span>
          </div>
        )}
      </section>
    </div>
  )
}
