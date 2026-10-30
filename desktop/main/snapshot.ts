import type { ActivityRecord, DesktopSnapshot } from "../shared/contracts"

export function appendActivity(
  snapshot: Pick<DesktopSnapshot, "activity" | "totals">,
  record: ActivityRecord,
): Pick<DesktopSnapshot, "activity" | "totals"> {
  return {
    activity: [record, ...snapshot.activity].slice(0, 200),
    totals: {
      requests: snapshot.totals.requests + 1,
      errors: snapshot.totals.errors + (record.outcome === "failed" ? 1 : 0),
      inputTokens: snapshot.totals.inputTokens + (record.inputTokens ?? 0),
      outputTokens: snapshot.totals.outputTokens + (record.outputTokens ?? 0),
      cachedTokens: snapshot.totals.cachedTokens + (record.cachedTokens ?? 0),
    },
  }
}

export function initialSnapshot(
  options: Pick<
    DesktopSnapshot,
    "version" | "platform" | "fixture" | "storageMode" | "settings"
  > & {
    recovered: boolean
  },
): DesktopSnapshot {
  return {
    revision: 0,
    version: options.version,
    platform: options.platform,
    fixture: options.fixture,
    storageMode: options.storageMode,
    account: { kind: "signed-out" },
    gateway: { kind: "stopped" },
    settings: options.settings,
    models: [],
    modelsFetchedAt: null,
    usage: null,
    activity: [],
    totals: {
      requests: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
    },
    probe: { kind: "idle" },
    notice:
      options.recovered ?
        {
          kind: "error",
          message:
            "Saved settings could not be read. Default settings are active.",
        }
      : null,
  }
}
