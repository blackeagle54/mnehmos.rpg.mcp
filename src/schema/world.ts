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

export const WorldSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  seed: z.string().min(1),
  width: z.number().positive(),
  height: z.number().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  environment: EnvironmentSchema.optional(),
});

export type World = z.infer<typeof WorldSchema>;
