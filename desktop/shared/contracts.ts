import { z } from "zod"

import type { CatalogModel } from "../../src/lib/proxy-contracts"

import {
  activitySchema,
  agentConfigViewSchema,
  agentModelChoicesSchema,
  agentTargetSchema,
  authorizationSchema,
  configurableAgentSchema,
  configureResultSchema,
  modelSchema,
  proxySourceSchema,
  publicConnectionSchema,
  runtimeOptionsSchema,
  totalsSchema,
  usageSchema,
} from "../../src/lib/proxy-contracts"

export {
  activitySchema,
  agentConfigViewSchema,
  agentModelChoicesSchema,
  agentTargetSchema,
  authorizationSchema,
  configurableAgentSchema,
  configureResultSchema,
  modelSchema,
  proxySourceSchema,
  publicConnectionSchema,
  runtimeOptionsSchema,
  totalsSchema,
  usageSchema,
} from "../../src/lib/proxy-contracts"
export type {
  ActivityRecord,
  AgentConfigView,
  AgentModel,
  AgentModelChoices,
  AgentTarget,
  ConfigurableAgent,
  ConfigureResult,
  ProxySource,
  PublicConnection,
} from "../../src/lib/proxy-contracts"

export const settingsSchema = z
  .object({
    port: z.number().int().min(1024).max(65535).default(4141),
    accountType: z
      .enum(["individual", "business", "enterprise"])
      .default("individual"),
    startOnLaunch: z.boolean().default(true),
    launchAtLogin: z.boolean().default(false),
    closeToTray: z.boolean().default(true),
    theme: z.enum(["system", "light", "dark"]).default("system"),
    preferredModel: z.string().max(200).default(""),
    agentModelChoices: agentModelChoicesSchema.default({
      "claude-code": null,
      codex: null,
      opencode: null,
    }),
    shell: z.enum(["posix", "powershell"]).default("posix"),
  })
  .strict()

export type DesktopSettings = z.infer<typeof settingsSchema>

export const accountSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("signed-out") }),
  z.object({ kind: z.literal("external-unverified") }),
  z.object({ kind: z.literal("connecting") }),
  z.object({
    kind: z.literal("awaiting-authorization"),
    code: z.string(),
    verificationUri: z.string(),
    expiresAt: z.iso.datetime({ offset: true }),
  }),
  z.object({
    kind: z.literal("signed-in"),
    login: z.string(),
    name: z.string().nullable(),
    plan: z.string(),
  }),
  z.object({ kind: z.literal("error"), message: z.string() }),
])

export const gatewaySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stopped") }),
  z.object({ kind: z.literal("starting") }),
  z.object({
    kind: z.literal("running"),
    url: z.string(),
    startedAt: z.string(),
  }),
  z.object({ kind: z.literal("stopping") }),
  z.object({
    kind: z.literal("draining"),
    inFlight: z.number().int().nonnegative(),
  }),
  z.object({ kind: z.literal("error"), message: z.string() }),
])

export type DesktopModel = CatalogModel

export const probeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("idle") }),
  z.object({ kind: z.literal("running"), model: z.string() }),
  z.object({
    kind: z.literal("complete"),
    model: z.string(),
    text: z.string(),
    durationMs: z.number(),
  }),
  z.object({ kind: z.literal("error"), message: z.string() }),
])

export const snapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  version: z.string(),
  platform: z.enum(["darwin", "win32", "linux"]),
  fixture: z.boolean(),
  storageMode: z.enum(["encrypted", "session-only"]),
  account: accountSchema,
  authorization: authorizationSchema.default({ kind: "idle" }),
  gateway: gatewaySchema,
  connection: publicConnectionSchema.nullable().default(null),
  source: proxySourceSchema.default({ kind: "none" }),
  runtime: runtimeOptionsSchema.nullable().default(null),
  settings: settingsSchema,
  agentConfigs: z.array(agentConfigViewSchema).default([]),
  lastConfigureResult: configureResultSchema.nullable().default(null),
  models: z.array(modelSchema),
  modelsFetchedAt: z.string().nullable(),
  usage: usageSchema.nullable(),
  activity: z.array(activitySchema),
  totals: totalsSchema,
  probe: probeSchema,
  notice: z
    .object({
      kind: z.enum(["info", "error"]),
      message: z.string(),
    })
    .nullable(),
})

export type DesktopSnapshot = z.infer<typeof snapshotSchema>

export const commandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sign-in") }).strict(),
  z.object({ kind: z.literal("cancel-sign-in") }).strict(),
  z.object({ kind: z.literal("open-device-page") }).strict(),
  z.object({ kind: z.literal("sign-out") }).strict(),
  z.object({ kind: z.literal("start-gateway") }).strict(),
  z.object({ kind: z.literal("stop-gateway") }).strict(),
  z.object({ kind: z.literal("refresh") }).strict(),
  z.object({ kind: z.literal("clear-activity") }).strict(),
  z.object({ kind: z.literal("rotate-key") }).strict(),
  z.object({ kind: z.literal("dismiss-notice") }).strict(),
  z
    .object({ kind: z.literal("save-settings"), settings: settingsSchema })
    .strict(),
  z
    .object({
      kind: z.literal("select-model"),
      modelId: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      kind: z.literal("select-agent-model"),
      target: configurableAgentSchema,
      modelId: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      kind: z.literal("inspect-agent-config"),
      target: configurableAgentSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("configure-agent"),
      target: configurableAgentSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("open-config-folder"),
      target: configurableAgentSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("copy"),
      target: z.enum(["base-url", "gateway-key", "device-code"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("copy-config"),
      target: agentTargetSchema,
      modelId: z.string().min(1).max(200),
      shell: z.enum(["posix", "powershell"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("run-probe"),
      modelId: z.string().min(1).max(200),
      prompt: z.string().min(1).max(4000),
    })
    .strict(),
])

export type DesktopCommand = z.infer<typeof commandSchema>

export interface DesktopBridge {
  snapshot(): Promise<DesktopSnapshot>
  invoke(command: DesktopCommand): Promise<DesktopSnapshot>
  subscribe(listener: (snapshot: DesktopSnapshot) => void): () => void
}

export const IPC_CHANNELS = {
  snapshot: "copilot-proxy:snapshot",
  command: "copilot-proxy:command",
  update: "copilot-proxy:update",
} as const
