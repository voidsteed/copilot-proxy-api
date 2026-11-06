import { z } from "zod"

import {
  completedActivitySchema,
  runtimeAuthenticationSchema,
  runtimeOptionsSchema,
} from "../../src/lib/proxy-contracts"
import { settingsSchema } from "../shared/contracts"
import { fixtureOriginSchema, upstreamCatalogSchema } from "./upstream"

export const engineInitSchema = z
  .object({
    kind: z.literal("init"),
    githubToken: z.string().min(1).max(16_384),
    gatewayKey: z.string().min(1).max(4096).optional(),
    authentication: runtimeAuthenticationSchema.optional(),
    port: settingsSchema.shape.port,
    accountType: settingsSchema.shape.accountType,
    options: runtimeOptionsSchema.optional(),
    fixtureOrigin: fixtureOriginSchema.optional(),
  })
  .strict()

export type EngineInit = z.infer<typeof engineInitSchema>

export const engineCommandSchema = z.union([
  engineInitSchema,
  z.object({ kind: z.literal("stop") }).strict(),
  z
    .object({
      kind: z.literal("drain"),
      id: z.number().int().positive(),
      timeoutMs: z.number().int().min(1).max(60_000),
    })
    .strict(),
  z
    .object({ kind: z.literal("resume"), id: z.number().int().positive() })
    .strict(),
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
      kind: z.literal("drained"),
      id: z.number().int().positive(),
      inFlight: z.literal(0),
    })
    .strict(),
  z
    .object({
      kind: z.literal("drain-timeout"),
      id: z.number().int().positive(),
      inFlight: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({ kind: z.literal("resumed"), id: z.number().int().positive() })
    .strict(),
  z
    .object({
      kind: z.literal("draining"),
      inFlight: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("catalog-updated"),
      id: z.number().int().positive(),
    })
    .strict(),
  z
    .object({ kind: z.literal("activity"), record: completedActivitySchema })
    .strict(),
  z
    .object({
      kind: z.literal("error"),
      code: z.enum(["address-in-use", "authentication", "upstream", "startup"]),
    })
    .strict(),
])

export type EngineEvent = z.infer<typeof engineEventSchema>
