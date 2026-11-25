import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { z } from "zod"

import type { DesktopModel, DesktopSnapshot } from "../shared/contracts"

import { authorizationSchema } from "../../src/lib/proxy-contracts"
import { initialSnapshot } from "../main/snapshot"
import {
  ActivityView,
  filterActivityRecords,
  RequestTable,
} from "../renderer/ActivityView"
import { AgentsView } from "../renderer/AgentsView"
import {
  commandKey,
  errorMessage,
  shouldAcceptSnapshot,
} from "../renderer/bridge"
import { formatDate, formatDateTime, ModelSelect } from "../renderer/components"
import { filterCatalogModels, ModelsView } from "../renderer/ModelsView"
import { OverviewView } from "../renderer/OverviewView"
import { SettingsView } from "../renderer/SettingsView"
import {
  accountSchema,
  publicConnectionSchema,
  settingsSchema,
  snapshotSchema,
} from "../shared/contracts"

const checkedAt = "2026-11-02T18:15:00Z"
const base = initialSnapshot({
  version: "test",
  platform: "darwin",
  fixture: true,
  storageMode: "session-only",
  settings: settingsSchema.parse({}),
  recovered: false,
})

function fixture(overrides: Partial<DesktopSnapshot> = {}): DesktopSnapshot {
  return snapshotSchema.parse({
    ...base,
    account: { kind: "signed-in", login: "fixture", name: null, plan: "test" },
    modelsFetchedAt: checkedAt,
    usage: {
      plan: "test",
      resetAt: "2026-12-01",
      fetchedAt: checkedAt,
      quotas: [
        {
          kind: "limited",
          id: "premium",
          label: "Premium",
          remaining: 20,
          limit: 100,
          percentRemaining: 20,
        },
      ],
    },
    ...overrides,
  })
}

function props(snapshot: DesktopSnapshot) {
  return {
    snapshot,
    run: () => Promise.resolve(true),
    pending: new Set<never>(),
    testRequest: { open: false, modelId: "" },
    onTestToggle: () => {},
    onNavigate: () => {},
    onProbe: () => {},
    onTest: () => {},
  }
}

function observed(startedAt: string) {
  return {
    id: "repeated-id",
    startedAt,
    method: "POST",
    path: "/v1/messages",
    status: 200,
    durationMs: 125,
    model: null,
    outcome: "observed",
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
  } satisfies DesktopSnapshot["activity"][number]
}

function legacy(overrides: Partial<DesktopSnapshot> = {}) {
  return fixture({
    account: { kind: "external-unverified" },
    connection: publicConnectionSchema.parse({
      rootUrl: "http://127.0.0.1:4141",
      apiUrl: "http://127.0.0.1:4141/v1",
      authentication: { kind: "none" },
    }),
    source: {
      kind: "legacy-cli",
      status: "reachable",
      observedAt: checkedAt,
      capabilities: {
        kind: "legacy",
        runtime: "read-only",
        account: "unverified",
        activity: "observed",
        drain: false,
      },
    },
    ...overrides,
  })
}

test("calendar resets preserve their day and year in every test timezone", () => {
  expect(formatDate("2026-12-01")).toBe("Dec 1, 2026")
  expect(formatDate("2026-01-01")).toBe("Jan 1, 2026")
  expect(formatDate("2024-02-29")).toBe("Feb 29, 2024")
  expect(formatDate("2025-12-01")).toBe("Dec 1, 2025")
  for (const value of [
    "2026-02-30",
    "2026-02-29",
    "2026-13-01",
    "not-a-date",
    "",
  ])
    expect(formatDate(value)).toBe("Unknown")
})

test("instant formatter includes local date year and clock and rejects invalid input", () => {
  const value = formatDateTime(checkedAt)
  expect(value).toContain("2026")
  expect(value).toContain("Nov")
  expect(value).toMatch(/\d{1,2}:15/)
  expect(value).not.toBe(formatDateTime("2026-11-03T18:15:00Z"))
  expect(formatDateTime("not-a-date")).toBe("Unknown")
  expect(formatDateTime("2026-02-30T12:00:00Z")).toBe("Unknown")
})

test("whole Overview and Models show successful checked instants and exact source titles", () => {
  const snapshot = fixture()
  const overview = renderToStaticMarkup(<OverviewView {...props(snapshot)} />)
  const models = renderToStaticMarkup(<ModelsView {...props(snapshot)} />)
  expect(overview).toContain("Resets Dec 1, 2026")
  for (const html of [overview, models]) {
    expect(html).toContain(`Checked ${formatDateTime(checkedAt)}`)
    expect(html).toContain(`title="${checkedAt}"`)
    expect(html).not.toContain("Updated ")
  }
  const empty = fixture({ usage: null, modelsFetchedAt: null })
  expect(
    renderToStaticMarkup(<OverviewView {...props(empty)} />),
  ).not.toContain("Checked ")
  expect(renderToStaticMarkup(<ModelsView {...props(empty)} />)).not.toContain(
    "Checked ",
  )
})

test("legacy quota refresh is enabled and unavailable copy requests refresh", () => {
  const html = renderToStaticMarkup(
    <OverviewView {...props(legacy({ usage: null }))} />,
  )
  const button = html.match(/<button[^>]*aria-label="Refresh usage"[^>]*>/)?.[0]
  expect(button).toBeDefined()
  expect(button).not.toContain("disabled")
  expect(html).toContain("Refresh to check your Copilot allowance.")
  expect(html).not.toContain("Sign in to see your Copilot allowance.")
})

test("200 retained legacy requests use recent labels and cannot clear provider history", () => {
  const activity = Array.from({ length: 200 }, (_, index) => ({
    ...observed(checkedAt),
    id: `request-${index}`,
  }))
  const snapshot = legacy({ activity })
  const html = renderToStaticMarkup(<ActivityView {...props(snapshot)} />)
  expect(html).toContain("200 recent CLI requests")
  expect(
    html.match(/<button[^>]*data-testid="clear-activity"[^>]*>/)?.[0],
  ).toContain("disabled")
  expect(renderToStaticMarkup(<OverviewView {...props(snapshot)} />)).toContain(
    "<span>Recent requests</span><strong>200</strong>",
  )
  const native = renderToStaticMarkup(
    <ActivityView {...props(fixture({ activity }))} />,
  )
  expect(
    native.match(/<button[^>]*data-testid="clear-activity"[^>]*>/)?.[0],
  ).not.toContain("disabled")
})

test("same-ID history rows retain distinct dates and DST source offsets", () => {
  const starts = [
    "2026-11-01T01:30:00-07:00",
    "2026-11-01T01:30:00-08:00",
    "2026-11-02T18:15:00Z",
  ]
  const html = renderToStaticMarkup(
    <RequestTable records={starts.map((startedAt) => observed(startedAt))} />,
  )
  expect(html.match(/class="request-expander"/g)).toHaveLength(3)
  for (const startedAt of starts) {
    expect(html).toContain(`dateTime="${startedAt}"`)
    expect(html).toContain(`title="${startedAt}"`)
    expect(html).toContain(formatDateTime(startedAt))
  }
  expect(html).toContain("Not reported")
  expect(html).toContain("200 observed")
  expect(html).toContain("n/a")
  expect(html).toContain("CLI handler time")
  const invalid = renderToStaticMarkup(
    <RequestTable records={[observed("not-a-date")]} />,
  )
  expect(invalid).toContain("Unknown")
  expect(invalid).not.toContain("Invalid Date")
})

test("public OAuth boundaries reject invalid expiry and accept offset instants", () => {
  for (const expiresAt of [
    "not-a-date",
    "2026-02-30T12:00:00Z",
    "2026-11-04T12:00:00",
  ]) {
    expect(
      accountSchema.safeParse({
        kind: "awaiting-authorization",
        code: "fixture",
        verificationUri: "https://github.com/login/device",
        expiresAt,
      }).success,
    ).toBe(false)
    expect(
      authorizationSchema.safeParse({
        kind: "awaiting",
        id: "fixture",
        code: "fixture",
        verificationUri: "https://github.com/login/device",
        expiresAt,
      }).success,
    ).toBe(false)
  }
  for (const expiresAt of [
    "2026-11-04T12:00:00Z",
    "2026-11-04T12:00:00-08:00",
  ]) {
    expect(
      accountSchema.safeParse({
        kind: "awaiting-authorization",
        code: "fixture",
        verificationUri: "https://github.com/login/device",
        expiresAt,
      }).success,
    ).toBe(true)
    expect(
      authorizationSchema.safeParse({
        kind: "awaiting",
        id: "fixture",
        code: "fixture",
        verificationUri: "https://github.com/login/device",
        expiresAt,
      }).success,
    ).toBe(true)
  }
})

test("session-scoped revision guard accepts new sessions and strictly newer revisions", () => {
  expect(
    shouldAcceptSnapshot(null, { sessionId: "session-a", revision: 0 }),
  ).toBe(true)
  expect(
    shouldAcceptSnapshot(
      { sessionId: "session-a", revision: 5 },
      { sessionId: "session-a", revision: 6 },
    ),
  ).toBe(true)
  expect(
    shouldAcceptSnapshot(
      { sessionId: "session-a", revision: 5 },
      { sessionId: "session-a", revision: 5 },
    ),
  ).toBe(false)
  expect(
    shouldAcceptSnapshot(
      { sessionId: "session-a", revision: 5 },
      { sessionId: "session-a", revision: 2 },
    ),
  ).toBe(false)
  expect(
    shouldAcceptSnapshot(
      { sessionId: "session-a", revision: 50 },
      { sessionId: "session-b", revision: 0 },
    ),
  ).toBe(true)
})

test("commandKey separates distinct sibling agent and copy commands", () => {
  expect(
    commandKey({ kind: "inspect-agent-config", target: "claude-code" }),
  ).not.toBe(commandKey({ kind: "inspect-agent-config", target: "codex" }))
  expect(commandKey({ kind: "copy", target: "base-url" })).not.toBe(
    commandKey({ kind: "copy", target: "gateway-key" }),
  )
  expect(
    commandKey({
      kind: "copy-config",
      target: "codex",
      modelId: "gpt-5",
      shell: "posix",
    }),
  ).not.toBe(
    commandKey({
      kind: "copy-config",
      target: "codex",
      modelId: "gpt-5",
      shell: "powershell",
    }),
  )
  expect(commandKey({ kind: "refresh" })).toBe(commandKey({ kind: "refresh" }))
})

test("errorMessage formats ZodErrors and strips Electron IPC prefixes cleanly", () => {
  const parsed = z.object({ revision: z.number() }).safeParse({ revision: "x" })
  expect(parsed.success).toBe(false)
  if (!parsed.success) {
    const formatted = errorMessage(parsed.error)
    expect(formatted).toContain("unexpected response")
    expect(formatted).toContain("revision")
    expect(formatted).not.toContain("{")
    expect(formatted).not.toContain("[")
  }
  expect(
    errorMessage(
      new Error(
        "Error invoking remote method 'copilot-proxy:command': Error: Port is already in use.",
      ),
    ),
  ).toBe("Port is already in use.")
  expect(errorMessage("unexpected")).toBe(
    "The action could not be completed. Try again.",
  )
})

test("ModelSelect shows a disabled placeholder whenever value is empty or missing from models", () => {
  const models: Array<DesktopModel> = [
    {
      id: "gpt-5",
      name: "GPT-5",
      vendor: "OpenAI",
      contextWindow: 128_000,
      maxOutput: 16_000,
      supports: ["tools"],
      endpoints: ["/responses"],
      preview: false,
    },
  ]
  const emptyHtml = renderToStaticMarkup(
    <ModelSelect models={models} value="" onChange={() => {}} />,
  )
  expect(emptyHtml).toContain("Select a model")
  expect(emptyHtml).toMatch(/<option[^>]*value=""[^>]*disabled=""[^>]*>/)
  const missingHtml = renderToStaticMarkup(
    <ModelSelect models={models} value="removed-model" onChange={() => {}} />,
  )
  expect(missingHtml).toContain("Select a model")
  const matchedHtml = renderToStaticMarkup(
    <ModelSelect models={models} value="gpt-5" onChange={() => {}} />,
  )
  expect(matchedHtml).not.toContain("Select a model")
})

test("ActivityView and ModelsView reconcile stale filters back to all items", () => {
  const records = [
    { ...observed(checkedAt), id: "r1", model: "gpt-5", outcome: "completed" },
    { ...observed(checkedAt), id: "r2", model: "claude", outcome: "failed" },
  ] satisfies DesktopSnapshot["activity"]
  const staleActivity = filterActivityRecords(records, {
    modelFilter: "removed-model",
    outcomeFilter: "",
  })
  expect(staleActivity.activeModelFilter).toBe("")
  expect(staleActivity.filtered).toHaveLength(2)

  const validActivity = filterActivityRecords(records, {
    modelFilter: "gpt-5",
    outcomeFilter: "",
  })
  expect(validActivity.activeModelFilter).toBe("gpt-5")
  expect(validActivity.filtered).toHaveLength(1)

  const catalog: Array<DesktopModel> = [
    {
      id: "claude-sonnet",
      name: "Claude Sonnet",
      vendor: "Anthropic",
      contextWindow: 200_000,
      maxOutput: 16_000,
      supports: ["tools"],
      endpoints: ["/chat/completions"],
      preview: false,
    },
  ]
  const staleModels = filterCatalogModels(catalog, {
    query: "",
    vendor: "RemovedVendor",
    feature: "",
  })
  expect(staleModels.activeVendor).toBe("")
  expect(staleModels.filtered).toBe(false)
  expect(staleModels.models).toHaveLength(1)
})

function buttonWith(html: string, label: string): string | undefined {
  return html
    .match(/<button\b[\s\S]*?<\/button>/g)
    ?.find((button) => button.includes(label))
}

test("OverviewView and SettingsView gate copy actions on running gateway and expose Disconnect CLI", () => {
  const keyedConnection = publicConnectionSchema.parse({
    rootUrl: "http://127.0.0.1:4141",
    apiUrl: "http://127.0.0.1:4141/v1",
    authentication: { kind: "keyed" },
  })
  const stoppedWithConnection = fixture({
    gateway: { kind: "stopping" },
    connection: keyedConnection,
  })
  const stoppedOverview = renderToStaticMarkup(
    <OverviewView {...props(stoppedWithConnection)} />,
  )
  expect(buttonWith(stoppedOverview, "Copy URL")).toContain('disabled=""')
  expect(buttonWith(stoppedOverview, "Copy key")).toContain('disabled=""')

  const runningWithConnection = fixture({
    gateway: {
      kind: "running",
      url: "http://127.0.0.1:4141/v1",
      startedAt: checkedAt,
    },
    connection: keyedConnection,
  })
  const runningOverview = renderToStaticMarkup(
    <OverviewView {...props(runningWithConnection)} />,
  )
  expect(buttonWith(runningOverview, "Copy URL")).not.toContain("disabled")
  expect(buttonWith(runningOverview, "Copy key")).not.toContain("disabled")

  const stoppedSettings = renderToStaticMarkup(
    <SettingsView {...props(stoppedWithConnection)} />,
  )
  expect(
    buttonWith(stoppedSettings, 'aria-label="Copy local API key"'),
  ).toContain('disabled=""')
  const runningSettings = renderToStaticMarkup(
    <SettingsView {...props(runningWithConnection)} />,
  )
  expect(
    buttonWith(runningSettings, 'aria-label="Copy local API key"'),
  ).not.toContain("disabled")

  const legacyError = legacy({
    gateway: { kind: "error", message: "The CLI proxy is unreachable." },
  })
  const legacyHtml = renderToStaticMarkup(
    <OverviewView {...props(legacyError)} />,
  )
  expect(legacyHtml).toContain('data-testid="detach-legacy"')
  expect(legacyHtml).toContain("Disconnect CLI")
  const legacyRunningHtml = renderToStaticMarkup(
    <OverviewView
      {...props(
        legacy({
          gateway: {
            kind: "running",
            url: "http://127.0.0.1:4141/v1",
            startedAt: checkedAt,
          },
        }),
      )}
    />,
  )
  expect(legacyRunningHtml).not.toContain('data-testid="detach-legacy"')
})

test("TestRequestPanel excludes embeddings-only models and allows dismissing probe results", () => {
  const snapshot = fixture({
    gateway: {
      kind: "running",
      url: "http://127.0.0.1:4141/v1",
      startedAt: checkedAt,
    },
    connection: publicConnectionSchema.parse({
      rootUrl: "http://127.0.0.1:4141",
      apiUrl: "http://127.0.0.1:4141/v1",
      authentication: { kind: "keyed" },
    }),
    models: [
      {
        id: "text-embedding-3-small",
        name: "Embedding Small",
        vendor: "OpenAI",
        contextWindow: 8192,
        maxOutput: null,
        supports: [],
        endpoints: ["/embeddings"],
        preview: false,
      },
      {
        id: "gpt-5",
        name: "GPT-5",
        vendor: "OpenAI",
        contextWindow: 200_000,
        maxOutput: 16_000,
        supports: ["tools"],
        endpoints: ["/responses"],
        preview: false,
      },
    ],
    probe: {
      kind: "complete",
      model: "gpt-5",
      text: "Copilot Proxy is connected.",
      durationMs: 240,
    },
  })
  const html = renderToStaticMarkup(
    <OverviewView
      {...props(snapshot)}
      testRequest={{ open: true, modelId: "" }}
    />,
  )
  expect(html).not.toContain("Embedding Small")
  expect(html).toContain("GPT-5")
  expect(html).toContain('aria-label="Dismiss test result"')
})

test("ModelsView empty-state refresh button tracks refresh pending state and AgentsView explains multi-API compatibility", () => {
  const refreshPending = renderToStaticMarkup(
    <ModelsView
      {...props(fixture({ models: [] }))}
      pending={new Set(["refresh"])}
    />,
  )
  expect(refreshPending).toMatch(
    /<button[^>]*disabled=""[^>]*aria-busy="true"[^>]*>.*Refresh models/,
  )

  const embeddingsOnly = fixture({
    models: [
      {
        id: "text-embedding-3-small",
        name: "Embedding Small",
        vendor: "OpenAI",
        contextWindow: 8192,
        maxOutput: null,
        supports: [],
        endpoints: ["/embeddings"],
        preview: false,
      },
    ],
  })
  const agentsHtml = renderToStaticMarkup(
    <AgentsView {...props(embeddingsOnly)} />,
  )
  expect(agentsHtml).toContain("Chat Completions or the Responses API")
})
