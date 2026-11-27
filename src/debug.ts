#!/usr/bin/env node

import { defineCommand } from "citty"
import consola from "consola"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { z } from "zod"

import type { PublicConnection } from "./lib/proxy-contracts"

import { PATHS } from "./lib/paths"
import { cliProxyOptions, observeProxySession } from "./lib/proxy-session"

interface ProxyDebug {
  kind: "standalone" | "unavailable" | "managed" | "legacy"
  connection: PublicConnection | null
  credentialStorage:
    | "standalone-file"
    | "encrypted"
    | "session-only"
    | "external-unverified"
    | "unavailable"
  accountLogin: string | null
  models: number
  observedRequests: number
  message?: string
}

interface DebugInfo {
  version: string
  runtime: {
    name: string
    version: string
    platform: string
    arch: string
  }
  paths: {
    APP_DIR: string
    GITHUB_TOKEN_PATH: string
  }
  tokenExists: boolean
  proxy: ProxyDebug
}

interface RunDebugOptions {
  json: boolean
  homeDirectory?: string
  stateDirectory?: string
}

async function getPackageVersion(): Promise<string> {
  try {
    const packageJsonPath = new URL("../package.json", import.meta.url).pathname
    const text = new TextDecoder().decode(await fs.readFile(packageJsonPath))
    const packageJson = z
      .object({ version: z.string() })
      .parse(JSON.parse(text))
    return packageJson.version
  } catch {
    return "unknown"
  }
}

function getRuntimeInfo() {
  const isBun = typeof Bun !== "undefined"

  return {
    name: isBun ? "bun" : "node",
    version: isBun ? Bun.version : process.version.slice(1),
    platform: os.platform(),
    arch: os.arch(),
  }
}

async function checkTokenExists(filename: string): Promise<boolean> {
  try {
    const stats = await fs.stat(filename)
    if (!stats.isFile()) return false

    const content = await fs.readFile(filename, "utf8")
    return content.trim().length > 0
  } catch {
    return false
  }
}

async function getProxyDebug(
  options: Pick<RunDebugOptions, "homeDirectory" | "stateDirectory">,
): Promise<ProxyDebug> {
  const session = await observeProxySession(await cliProxyOptions(options))
  if (session.kind === "standalone" || session.kind === "unavailable")
    return {
      kind: session.kind,
      connection: null,
      credentialStorage:
        session.kind === "standalone" ? "standalone-file" : "unavailable",
      accountLogin: null,
      models: 0,
      observedRequests: 0,
      ...(session.kind === "unavailable" ? { message: session.message } : {}),
    }
  try {
    const snapshot = await session.read()
    if (snapshot.kind === "legacy")
      return {
        kind: "legacy",
        connection: snapshot.connection,
        credentialStorage: "external-unverified",
        accountLogin: null,
        models: snapshot.catalog.length,
        observedRequests: snapshot.activity.length,
      }
    return {
      kind: "managed",
      connection:
        snapshot.gateway.kind === "running" ?
          snapshot.gateway.connection
        : null,
      credentialStorage: snapshot.storageMode,
      accountLogin:
        snapshot.account.kind === "signed-in" ? snapshot.account.login : null,
      models: snapshot.catalog.length,
      observedRequests: snapshot.activity.length,
    }
  } finally {
    await session.release()
  }
}

export async function getDebugInfo(
  options: Pick<RunDebugOptions, "homeDirectory" | "stateDirectory"> = {},
): Promise<DebugInfo> {
  const proxy = await getProxyDebug(options)
  const appDirectory =
    options.homeDirectory ?
      path.join(options.homeDirectory, ".local", "share", "copilot-proxy-api")
    : PATHS.APP_DIR
  const tokenPath = path.join(appDirectory, "github_token")
  const [version, tokenExists] = await Promise.all([
    getPackageVersion(),
    proxy.kind === "standalone" ?
      checkTokenExists(tokenPath)
    : Promise.resolve(false),
  ])

  return {
    version,
    runtime: getRuntimeInfo(),
    paths: {
      APP_DIR: appDirectory,
      GITHUB_TOKEN_PATH: tokenPath,
    },
    tokenExists,
    proxy,
  }
}

function printDebugInfoPlain(info: DebugInfo): void {
  consola.info(`copilot-proxy-api debug

Version: ${info.version}
Runtime: ${info.runtime.name} ${info.runtime.version} (${info.runtime.platform} ${info.runtime.arch})

Paths:
- APP_DIR: ${info.paths.APP_DIR}
- GITHUB_TOKEN_PATH: ${info.paths.GITHUB_TOKEN_PATH}

Proxy: ${info.proxy.kind}${info.proxy.connection ? ` at ${info.proxy.connection.rootUrl}` : ""}
Credential storage: ${info.proxy.credentialStorage}
Account: ${info.proxy.accountLogin ?? "Unverified or signed out"}
Models: ${info.proxy.models}
Recorded requests: ${info.proxy.observedRequests}
${info.proxy.message ?? ""}
Standalone token exists: ${info.tokenExists ? "Yes" : "No"}`)
}

function printDebugInfoJson(info: DebugInfo): void {
  console.log(JSON.stringify(info, null, 2))
}

export async function runDebug(options: RunDebugOptions): Promise<void> {
  const debugInfo = await getDebugInfo(options)

  if (options.json) {
    printDebugInfoJson(debugInfo)
  } else {
    printDebugInfoPlain(debugInfo)
  }
}

export const debug = defineCommand({
  meta: {
    name: "debug",
    description: "Print debug information about the application",
  },
  args: {
    json: {
      type: "boolean",
      default: false,
      description: "Output debug information as JSON",
    },
  },
  run({ args }) {
    return runDebug({
      json: args.json,
    })
  },
})
