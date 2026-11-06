import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import type { DesktopSnapshot } from "../shared/contracts"

import { authorizationSchema } from "../../src/lib/proxy-contracts"
import { initialSnapshot } from "../main/snapshot"
import { ActivityView, RequestTable } from "../renderer/ActivityView"
import { formatDate, formatDateTime } from "../renderer/components"
import { ModelsView } from "../renderer/ModelsView"
import { OverviewView } from "../renderer/OverviewView"
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
