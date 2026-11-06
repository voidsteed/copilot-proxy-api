import { defineCommand } from "citty"
import consola from "consola"

import type { UsageView } from "./lib/proxy-contracts"

import { ensurePaths } from "./lib/paths"
import {
  cliProxyOptions,
  observeProxySession,
  requireDefaultStandaloneProfile,
} from "./lib/proxy-session"
import { setupGitHubToken } from "./lib/token"
import {
  getCopilotUsage,
  type QuotaDetail,
} from "./services/github/get-copilot-usage"

function printSharedUsage(usage: UsageView): void {
  const quotas = usage.quotas.map((quota) => {
    if (quota.kind === "unlimited") return `  ${quota.label}: Unlimited`
    const used = quota.limit - quota.remaining
    return `  ${quota.label}: ${used}/${quota.limit} used (${quota.percentRemaining.toFixed(1)}% remaining)`
  })
  consola.box(
    `Copilot Usage (plan: ${usage.plan})\nQuota resets: ${usage.resetAt ?? "Unknown"}\n\nQuotas:\n${quotas.join("\n")}`,
  )
}

export async function runCheckUsage(
  options: { homeDirectory?: string; stateDirectory?: string } = {},
): Promise<void> {
  const context = await cliProxyOptions(options)
  const session = await observeProxySession(context)
  if (session.kind === "unavailable") throw new Error(session.message)
  if (session.kind !== "standalone") {
    try {
      if (
        session.kind === "managed"
        && (await session.read()).kind === "managed"
      ) {
        const result = await session.invoke({ kind: "refresh" })
        if (result.kind === "unavailable") throw new Error(result.message)
      }
      const snapshot = await session.read()
      if (!snapshot.usage)
        throw new Error(
          "The shared proxy has no quota information. Sign in or refresh in Copilot Proxy.",
        )
      printSharedUsage(snapshot.usage)
    } finally {
      await session.release()
    }
    return
  }
  requireDefaultStandaloneProfile(context.homeDirectory)
  await standaloneUsage()
}

async function standaloneUsage(): Promise<void> {
  await ensurePaths()
  await setupGitHubToken()
  try {
    const usage = await getCopilotUsage()
    const premium = usage.quota_snapshots.premium_interactions
    const premiumTotal = premium.entitlement
    const premiumUsed = premiumTotal - premium.remaining
    const premiumPercentUsed =
      premiumTotal > 0 ? (premiumUsed / premiumTotal) * 100 : 0
    const premiumPercentRemaining = premium.percent_remaining

    function summarizeQuota(name: string, snap: QuotaDetail | undefined) {
      if (!snap) return `${name}: N/A`
      const total = snap.entitlement
      const used = total - snap.remaining
      const percentUsed = total > 0 ? (used / total) * 100 : 0
      const percentRemaining = snap.percent_remaining
      return `${name}: ${used}/${total} used (${percentUsed.toFixed(1)}% used, ${percentRemaining.toFixed(1)}% remaining)`
    }

    const premiumLine = `Premium: ${premiumUsed}/${premiumTotal} used (${premiumPercentUsed.toFixed(1)}% used, ${premiumPercentRemaining.toFixed(1)}% remaining)`
    const chatLine = summarizeQuota("Chat", usage.quota_snapshots.chat)
    const completionsLine = summarizeQuota(
      "Completions",
      usage.quota_snapshots.completions,
    )

    consola.box(
      `Copilot Usage (plan: ${usage.copilot_plan})\n`
        + `Quota resets: ${usage.quota_reset_date}\n`
        + `\nQuotas:\n`
        + `  ${premiumLine}\n`
        + `  ${chatLine}\n`
        + `  ${completionsLine}`,
    )
  } catch (err) {
    consola.error("Failed to fetch Copilot usage:", err)
    process.exit(1)
  }
}

export const checkUsage = defineCommand({
  meta: {
    name: "check-usage",
    description: "Show the active Copilot Proxy usage/quota information",
  },
  run() {
    return runCheckUsage()
  },
})
