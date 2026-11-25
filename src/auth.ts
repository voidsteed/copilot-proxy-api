#!/usr/bin/env node

import { defineCommand } from "citty"
import consola from "consola"

import type { ManagedSession, ServiceSnapshot } from "./lib/proxy-contracts"

import { PATHS, ensurePaths } from "./lib/paths"
import {
  cliProxyOptions,
  observeProxySession,
  requireDefaultStandaloneProfile,
} from "./lib/proxy-session"
import { state } from "./lib/state"
import { setupGitHubToken } from "./lib/token"

interface RunAuthOptions {
  verbose: boolean
  showToken: boolean
  homeDirectory?: string
  stateDirectory?: string
  signal?: AbortSignal
}

function accountEpoch(snapshot: ServiceSnapshot): number {
  return snapshot.kind === "managed" && snapshot.account.kind === "signed-in" ?
      snapshot.account.epoch
    : -1
}

async function nativeAuthorize(options: {
  session: ManagedSession
  signal?: AbortSignal
}): Promise<void> {
  const before = await options.session.read()
  if (before.kind !== "managed")
    throw new Error(
      "The existing CLI account is read-only. Stop it normally before authorizing through Copilot Proxy.",
    )
  const result = await options.session.invoke({ kind: "authorize" })
  if (result.kind === "unavailable") throw new Error(result.message)
  if (result.kind !== "applied")
    throw new Error("The active proxy changed before authorization started.")
  await options.session.invoke({ kind: "show-ui" })
  const interrupted = new AbortController()
  const signal =
    options.signal ?
      AbortSignal.any([options.signal, interrupted.signal])
    : interrupted.signal
  const cancel = () => {
    interrupted.abort()
  }
  process.once("SIGINT", cancel)
  process.once("SIGTERM", cancel)
  let snapshot: ServiceSnapshot = result.snapshot
  let lastCode: string | null = null
  try {
    while (true) {
      if (signal.aborted) {
        if (
          snapshot.kind === "managed"
          && snapshot.authorization.kind !== "idle"
        )
          await options.session.invoke({
            kind: "cancel-authorization",
            authorizationId: snapshot.authorization.id,
          })
        throw new Error("GitHub authorization was cancelled.")
      }
      if (snapshot.kind !== "managed")
        throw new Error("The proxy changed during authorization.")
      if (snapshot.authorization.kind === "error")
        throw new Error(snapshot.authorization.message)
      if (
        snapshot.authorization.kind === "awaiting"
        && snapshot.authorization.code !== lastCode
      ) {
        lastCode = snapshot.authorization.code
        consola.info(
          `Approve ${lastCode} at ${snapshot.authorization.verificationUri}`,
        )
      }
      if (snapshot.authorization.kind === "idle") {
        if (
          snapshot.account.kind === "signed-in"
          && accountEpoch(snapshot) !== accountEpoch(before)
        ) {
          consola.success(
            `Signed in as ${snapshot.account.login}. Credentials stay in Copilot Proxy.`,
          )
          return
        }
        throw new Error(
          "GitHub authorization ended without changing the account.",
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
      snapshot = await options.session.read()
    }
  } finally {
    process.removeListener("SIGINT", cancel)
    process.removeListener("SIGTERM", cancel)
  }
}

export async function runAuth(options: RunAuthOptions): Promise<void> {
  if (options.verbose) {
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  state.showToken = options.showToken

  const context = await cliProxyOptions(options)
  const session = await observeProxySession(context)
  if (session.kind === "unavailable") throw new Error(session.message)
  if (session.kind === "legacy") {
    await session.release()
    throw new Error(
      "The existing CLI account is read-only. Stop it normally before authorizing through Copilot Proxy.",
    )
  }
  if (session.kind === "managed") {
    try {
      await nativeAuthorize({ session, signal: options.signal })
    } finally {
      await session.release()
    }
    return
  }

  requireDefaultStandaloneProfile(context.homeDirectory)

  await ensurePaths()
  await setupGitHubToken({ force: true })
  consola.success("GitHub token written to", PATHS.GITHUB_TOKEN_PATH)
}

export const auth = defineCommand({
  meta: {
    name: "auth",
    description: "Sign in to the active Copilot Proxy account",
  },
  args: {
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Show the GitHub token in standalone CLI mode",
    },
  },
  run({ args }) {
    return runAuth({
      verbose: args.verbose,
      showToken: args["show-token"],
    })
  },
})
