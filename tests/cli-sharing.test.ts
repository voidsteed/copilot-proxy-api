import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type {
  NativeIntent,
  NativeSessionAuthority,
  NativeSnapshot,
  ServiceSnapshot,
} from "~/lib/proxy-contracts"

import { runAuth } from "~/auth"
import { runCheckUsage } from "~/check-usage"
import { getDebugInfo } from "~/debug"
import {
  creatorLeaseSchema,
  nativeConnectionSchema,
  nativeSnapshotSchema,
} from "~/lib/proxy-contracts"
import {
  hostProxySession,
  writeNativeCredentialProvenance,
} from "~/lib/proxy-session"
import {
  claudeCodeCommand,
  explicitCliRuntime,
  runStart,
  type RunServerOptions,
} from "~/start"
import { runStop } from "~/stop"

let directory: string
let release: (() => Promise<void>) | undefined
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "copilot-cli-sharing-"))
})
afterEach(async () => {
  const dispose = release
  release = undefined
  await dispose?.()
  await rm(directory, { recursive: true, force: true })
})
const connection = nativeConnectionSchema.parse({
  rootUrl: "http://localhost:48923/",
  apiUrl: "http://localhost:48923/v1",
  authentication: {
    kind: "keyed",
    key: "fixture-real-key'with$metacharacters",
  },
})
const values: RunServerOptions = {
  port: 4141,
  verbose: false,
  accountType: "individual",
  manual: false,
  rateLimitWait: false,
  claudeCode: false,
  showToken: false,
  proxyEnv: false,
  responsesContextTrim: false,
}
const model = {
  id: "claude-sonnet-5.5",
  name: "Claude Sonnet",
  vendor: "Anthropic",
  preview: false,
  contextWindow: 200000,
  maxOutput: 64000,
  supports: [],
  endpoints: ["/responses", "/chat/completions"],
}

function roots() {
  return { homeDirectory: directory, stateDirectory: join(directory, "native") }
}

async function owner() {
  let snapshot = nativeSnapshotSchema.parse({
    kind: "managed",
    sessionId: "cli-shared-owner",
    gatewayGeneration: 7,
    revision: 1,
    account: {
      kind: "signed-in",
      login: "existing-native-user",
      name: null,
      plan: "fixture-plan",
      credentialSource: "native-vault",
      epoch: 2,
    },
    authorization: { kind: "idle" },
    storageMode: "encrypted",
    gateway: {
      kind: "running",
      connection: { ...connection, authentication: { kind: "keyed" } },
      startedAt: "2026-10-30T10:00:00.000Z",
    },
    options: {
      port: 48923,
      accountType: "enterprise",
      manualApprove: true,
      rateLimitSeconds: 4,
      rateLimitWait: true,
      responsesContextTrim: false,
      proxyFromEnvironment: false,
    },
    authentication: { kind: "keyed" },
    capabilities: {
      kind: "managed",
      runtime: "managed",
      account: "managed",
      activity: "completed",
      drain: true,
    },
    catalog: [model],
    usage: {
      plan: "owner-quota",
      resetAt: "2026-11-01",
      fetchedAt: "2026-10-30T10:00:00.000Z",
      quotas: [{ kind: "unlimited", id: "chat", label: "Chat" }],
    },
    activity: [],
    totals: {
      requests: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
    },
  })
  const listeners = new Set<(snapshot: ServiceSnapshot) => void>()
  const commands: Array<NativeIntent> = []
  const publish = (next: NativeSnapshot) => {
    snapshot = next
    for (const listener of listeners) listener(next)
  }
  const api: NativeSessionAuthority = {
    snapshot: () => snapshot,
    connection: () => connection,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async dispatch(intent) {
      await Promise.resolve()
      commands.push(intent)
      if (intent.kind === "authorize") {
        publish(
          nativeSnapshotSchema.parse({
            ...snapshot,
            authorization: { kind: "connecting", id: "fixture-auth-request" },
          }),
        )
        setTimeout(() => {
          publish(
            nativeSnapshotSchema.parse({
              ...snapshot,
              account: {
                ...snapshot.account,
                kind: "signed-in",
                login: "replacement-native-user",
                name: null,
                plan: "fixture-plan",
                credentialSource: "native-vault",
                epoch: 3,
              },
              authorization: { kind: "idle" },
            }),
          )
        }, 30)
      }
      if (intent.kind === "stop-gateway") {
        if (
          intent.expected.sessionId !== snapshot.sessionId
          || intent.expected.gatewayGeneration !== snapshot.gatewayGeneration
        )
          return { kind: "session-changed", snapshot }
        publish(
          nativeSnapshotSchema.parse({
            ...snapshot,
            gateway: { kind: "stopped" },
          }),
        )
      }
      return { kind: "applied", snapshot, createdGateway: null }
    },
  }
  const dispose = await hostProxySession({
    ...roots(),
    authority: api,
    showUi: () => {},
  })
  release = dispose
  return { commands, snapshot: () => snapshot }
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2000
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10))
  expect(predicate()).toBe(true)
}

describe("CLI shares the native authority", () => {
  test("default Start attaches without resetting enterprise options, then recognizes Stop from another client", async () => {
    const shared = await owner()
    const pending = runStart({
      ...roots(),
      values,
      explicit: explicitCliRuntime({ values, rawArgs: [] }),
    })
    await waitFor(() =>
      shared.commands.some((intent) => intent.kind === "ensure-running"),
    )
    expect(
      shared.commands.find((intent) => intent.kind === "ensure-running"),
    ).toMatchObject({
      explicit: {},
      credential: { kind: "native-saved-account" },
    })
    expect(shared.snapshot().options).toMatchObject({
      port: 48923,
      accountType: "enterprise",
      manualApprove: true,
      rateLimitSeconds: 4,
      rateLimitWait: true,
    })
    await runStop(roots())
    await pending
    expect(
      shared.commands.filter((intent) => intent.kind === "stop-gateway"),
    ).toEqual([
      {
        kind: "stop-gateway",
        expected: creatorLeaseSchema.parse({
          sessionId: "cli-shared-owner",
          gatewayGeneration: 7,
        }),
        timeoutMs: 15000,
      },
    ])
    await runStop(roots())
    expect(
      shared.commands.filter((intent) => intent.kind === "stop-gateway"),
    ).toHaveLength(1)
  })

  test("Auth, quota and Debug use the native account while preserving old plaintext credentials", async () => {
    const shared = await owner()
    const oldPath = join(
      directory,
      ".local",
      "share",
      "copilot-proxy-api",
      "github_token",
    )
    await mkdir(join(directory, ".local", "share", "copilot-proxy-api"), {
      recursive: true,
    })
    await writeFile(oldPath, "fixture-old-account-token")
    await runAuth({ ...roots(), verbose: false, showToken: false })
    expect(
      shared.commands.filter((intent) => intent.kind === "authorize"),
    ).toHaveLength(1)
    expect(
      shared.commands.filter((intent) => intent.kind === "show-ui"),
    ).toHaveLength(1)
    await runCheckUsage(roots())
    expect(
      shared.commands.filter((intent) => intent.kind === "refresh"),
    ).toHaveLength(1)
    const debug = await getDebugInfo(roots())
    expect(debug.proxy).toMatchObject({
      kind: "managed",
      accountLogin: "replacement-native-user",
      credentialStorage: "encrypted",
      models: 1,
    })
    expect(JSON.stringify(debug)).not.toContain(
      connection.authentication.kind === "keyed" ?
        connection.authentication.key
      : "unused",
    )
    expect(await readFile(oldPath, "utf8")).toBe("fixture-old-account-token")
  })

  test("native sign-out prevents Start and Auth from resurrecting preserved standalone credentials", async () => {
    await writeNativeCredentialProvenance({
      ...roots(),
      provenance: { kind: "native-authority", account: "signed-out" },
    })
    await runStart({ ...roots(), values, explicit: {} }).then(
      () => {
        throw new Error("Expected native-storage rejection")
      },
      (error: unknown) => {
        expect(error instanceof Error && error.message).toContain(
          "native Copilot Proxy storage",
        )
      },
    )
    await runAuth({ ...roots(), verbose: false, showToken: false }).then(
      () => {
        throw new Error("Expected native-storage rejection")
      },
      (error: unknown) => {
        expect(error instanceof Error && error.message).toContain(
          "native Copilot Proxy storage",
        )
      },
    )
  })

  test("runtime overrides include only explicitly supplied flags and their actual boolean/auth values", () => {
    expect(
      explicitCliRuntime({
        values: { ...values, rateLimit: 10, apiKey: "old-default" },
        rawArgs: ["--verbose"],
      }),
    ).toEqual({})
    expect(
      explicitCliRuntime({
        values: {
          ...values,
          port: 48925,
          manual: false,
          apiKey: "actual-one,actual-two",
        },
        rawArgs: [
          "--port=48925",
          "--no-manual",
          "--api-key",
          "actual-one,actual-two",
        ],
      }),
    ).toEqual({
      port: 48925,
      manualApprove: false,
      authentication: { kind: "keyed", keys: ["actual-one", "actual-two"] },
    })
    expect(
      explicitCliRuntime({
        values: { ...values, port: 48925, rateLimitWait: true },
        rawArgs: ["-p48925", "-w"],
      }),
    ).toEqual({ port: 48925, rateLimitWait: true })
    expect(explicitCliRuntime({ values, rawArgs: ["--api-key", ""] })).toEqual({
      authentication: { kind: "none" },
    })
    expect(
      explicitCliRuntime({
        values: { ...values, verbose: true, rateLimitWait: true },
        rawArgs: ["-vw"],
      }),
    ).toEqual({ rateLimitWait: true })
    expect(
      explicitCliRuntime({
        values: { ...values, githubToken: "--manual" },
        rawArgs: ["--github-token", "--manual"],
      }),
    ).toEqual({})
  })
})

describe("Claude instructions reflect saved config and actual auth", () => {
  test("a ready existing config uses its exact alias and keeps the small model independently configured", async () => {
    await mkdir(join(directory, ".claude"))
    const text = JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: connection.rootUrl,
        ANTHROPIC_AUTH_TOKEN:
          connection.authentication.kind === "keyed" ?
            connection.authentication.key
          : "",
        ANTHROPIC_MODEL: "claude-sonnet-5.5[1m]",
        ANTHROPIC_SMALL_FAST_MODEL: "claude-sonnet-5",
      },
      hooks: { existing: true },
    })
    const filename = join(directory, ".claude", "settings.json")
    await writeFile(filename, text)
    expect(
      await claudeCodeCommand({
        homeDirectory: directory,
        connection,
        catalog: [model],
        selectModel: () => {
          throw new Error("A configured model must not prompt")
        },
      }),
    ).toBe("claude")
    expect(await readFile(filename, "utf8")).toBe(text)
  })

  test("a keyed override uses the actual port/key and exact alias without replacing existing settings", async () => {
    await mkdir(join(directory, ".claude"))
    const text = JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "http://localhost:4141/",
        ANTHROPIC_AUTH_TOKEN: "fixture-old-key",
        ANTHROPIC_MODEL: "claude-sonnet-5.5[1m]",
        ANTHROPIC_SMALL_FAST_MODEL: "claude-sonnet-5",
      },
    })
    const filename = join(directory, ".claude", "settings.json")
    await writeFile(filename, text)
    const command = await claudeCodeCommand({
      homeDirectory: directory,
      connection,
      catalog: [model],
    })
    expect(command).toContain("ANTHROPIC_BASE_URL='http://localhost:48923/'")
    expect(command).toContain(
      String.raw`ANTHROPIC_AUTH_TOKEN='fixture-real-key'\''with$metacharacters'`,
    )
    expect(command).toContain("ANTHROPIC_MODEL='claude-sonnet-5.5[1m]'")
    expect(command).not.toContain("ANTHROPIC_SMALL_FAST_MODEL")
    expect(command).not.toContain("dummy")
    expect(await readFile(filename, "utf8")).toBe(text)
  })

  test("an unkeyed connection adds no invented auth value", async () => {
    const unkeyed = nativeConnectionSchema.parse({
      ...connection,
      authentication: { kind: "none" },
    })
    const command = await claudeCodeCommand({
      homeDirectory: directory,
      connection: unkeyed,
      catalog: [model],
      selectModel: () => Promise.resolve(model.id),
    })
    expect(command).not.toContain("ANTHROPIC_AUTH_TOKEN")
    expect(command).not.toContain("dummy")
    expect(command).toContain("ANTHROPIC_MODEL='claude-sonnet-5.5'")
  })
})
