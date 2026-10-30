import { z } from "zod"

import { activitySchema, settingsSchema } from "../shared/contracts"
import { fixtureOriginSchema, upstreamCatalogSchema } from "./upstream"

export const engineInitSchema = z
  .object({
    kind: z.literal("init"),
    githubToken: z.string().min(1).max(16_384),
    gatewayKey: z.string().min(32).max(256),
    port: settingsSchema.shape.port,
    accountType: settingsSchema.shape.accountType,
    fixtureOrigin: fixtureOriginSchema.optional(),
  })
  .strict()

export type EngineInit = z.infer<typeof engineInitSchema>

export const engineCommandSchema = z.union([
  engineInitSchema,
  z.object({ kind: z.literal("stop") }).strict(),
  z.object({ kind: z.literal("exit") }).strict(),
  z
    .object({
      kind: z.literal("catalog"),
      id: z.number().int().positive(),
      models: upstreamCatalogSchema,
    })
    .strict(),
])

export const engineEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready") }).strict(),
  z.object({ kind: z.literal("stopped") }).strict(),
  z
    .object({
      kind: z.literal("catalog-updated"),
      id: z.number().int().positive(),
    })
    .strict(),
  z.object({ kind: z.literal("activity"), record: activitySchema }).strict(),
  z
    .object({
      kind: z.literal("error"),
      code: z.enum(["address-in-use", "authentication", "upstream", "startup"]),
    })
    .strict(),
])

export type EngineEvent = z.infer<typeof engineEventSchema>
