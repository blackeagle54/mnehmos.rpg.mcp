import { z } from 'zod';

/**
 * Canonical world-environment schema. These are the field names persisted to the
 * worlds table and read by consumers (e.g. session_manage reads `timeOfDay`).
 * Tools that update the environment must converge on these names — see
 * normalizeEnvironmentPatch in world-manage for deprecated-alias mapping. (#65)
 */
export const EnvironmentSchema = z
  .object({
    date: z.string().optional(),
    timeOfDay: z.string().optional(),
    season: z.string().optional(),
    moonPhase: z.string().optional(),
    weatherConditions: z.string().optional(),
    temperature: z.string().optional(),
    lighting: z.string().optional(),
  })
  .passthrough();

export type Environment = z.infer<typeof EnvironmentSchema>;

/**
 * Procedural generation options that determine a world's terrain beyond its seed
 * and dimensions. These MUST be persisted so a world can be regenerated
 * (rehydrated) identically — restoring from seed/width/height alone drops these
 * and produces a materially different world. (#61)
 */
export const WorldGenOptionsSchema = z
  .object({
    landRatio: z.number().optional(),
    temperatureOffset: z.number().optional(),
    moistureOffset: z.number().optional(),
  })
  .passthrough();

export type WorldGenOptions = z.infer<typeof WorldGenOptionsSchema>;

export const WorldSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  seed: z.string().min(1),
  width: z.number().positive(),
  height: z.number().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  environment: EnvironmentSchema.optional(),
  genOptions: WorldGenOptionsSchema.optional(),
});

export type World = z.infer<typeof WorldSchema>;
