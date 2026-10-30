import { z } from "zod"

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
    shell: z.enum(["posix", "powershell"]).default("posix"),
  })
  .strict()

export type DesktopSettings = z.infer<typeof settingsSchema>

export const accountSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("signed-out") }),
  z.object({ kind: z.literal("connecting") }),
  z.object({
    kind: z.literal("awaiting-authorization"),
    code: z.string(),
    verificationUri: z.string(),
    expiresAt: z.string(),
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
  z.object({ kind: z.literal("error"), message: z.string() }),
])

export const modelSchema = z.object({
  id: z.string(),
  name: z.string(),
  vendor: z.string(),
  contextWindow: z.number().nullable(),
  maxOutput: z.number().nullable(),
  supports: z.array(z.enum(["tools", "vision", "reasoning", "streaming"])),
  endpoints: z.array(z.string()),
  preview: z.boolean(),
})

export type DesktopModel = z.infer<typeof modelSchema>

const quotaSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("limited"),
    id: z.string(),
    label: z.string(),
    remaining: z.number(),
    limit: z.number(),
    percentRemaining: z.number().min(0).max(100),
  }),
  z.object({ kind: z.literal("unlimited"), id: z.string(), label: z.string() }),
])

export const usageSchema = z.object({
  plan: z.string(),
  resetAt: z.string().nullable(),
  fetchedAt: z.string(),
  quotas: z.array(quotaSchema),
})

export const activitySchema = z.object({
  id: z.string(),
  startedAt: z.string(),
  method: z.string(),
  path: z.string(),
  model: z.string().nullable(),
  status: z.number(),
  outcome: z.enum(["completed", "failed", "cancelled"]),
  durationMs: z.number(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  cachedTokens: z.number().nullable(),
})

export type ActivityRecord = z.infer<typeof activitySchema>

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
  gateway: gatewaySchema,
  settings: settingsSchema,
  models: z.array(modelSchema),
  modelsFetchedAt: z.string().nullable(),
  usage: usageSchema.nullable(),
  activity: z.array(activitySchema),
  totals: z.object({
    requests: z.number().nonnegative(),
    errors: z.number().nonnegative(),
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    cachedTokens: z.number().nonnegative(),
  }),
  probe: probeSchema,
  notice: z
    .object({
      kind: z.enum(["info", "error"]),
      message: z.string(),
    })
    .nullable(),
})

export type DesktopSnapshot = z.infer<typeof snapshotSchema>

export const agentTargetSchema = z.enum([
  "claude-code",
  "codex",
  "opencode",
  "curl",
])
export type AgentTarget = z.infer<typeof agentTargetSchema>

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
  snapshot: "copilot-bridge:snapshot",
  command: "copilot-bridge:command",
  update: "copilot-bridge:update",
} as const
