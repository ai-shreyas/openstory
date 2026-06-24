/**
 * LLM Response Schemas
 *
 * Zod schemas for validating structured outputs from each analysis phase.
 * All derive from the canonical scene-analysis.schema.ts definitions.
 */

import { z } from 'zod';

import {
  characterBibleEntrySchema,
  continuitySchema,
  elementBibleEntrySchema,
  locationBibleEntrySchema,
  musicDesignSchema,
  projectMetadataSchema,
  sceneSchema,
} from './scene-analysis.schema';

/**
 * Talent Matching Response
 */
export const talentMatchResponseSchema = z.object({
  matches: z.array(
    z.object({
      characterId: z.string(),
      talentId: z.string(),
      confidence: z.number(), // 0-1 range enforced by prompt, not schema (Anthropic doesn't support min/max)
      reason: z.string(),
    })
  ),
});

/**
 * Location Matching Response
 */
export const locationMatchResponseSchema = z.object({
  matches: z.array(
    z.object({
      locationId: z.string(),
      libraryLocationId: z.string(),
      confidence: z.number(), // 0-1 range enforced by prompt
      reason: z.string(),
    })
  ),
});

/**
 * Phase 1: Scene Splitting
 */
export const sceneSplittingResultSchema = z.object({
  status: z
    .enum(['success', 'error', 'rejected'])
    .meta({ description: 'Processing status: success, error, or rejected' }),
  projectMetadata: projectMetadataSchema.meta({
    description: 'Project-level metadata extracted from script',
  }),
  scenes: z
    .array(
      sceneSchema
        .pick({
          sceneId: true,
          sceneNumber: true,
          originalScript: true,
          metadata: true,
        })
        .required()
        // Scene membership now lives upstream: scene-split, which already holds
        // the full script + bibles, emits each scene's `continuity` so the
        // visual-prompt LLM no longer has to derive it. Downstream prompt
        // workflows narrow their bible inputs with this. See #867.
        .extend({ continuity: continuitySchema })
    )
    .meta({ description: 'Array of scenes split from the script' }),
  characterBible: z.array(characterBibleEntrySchema).meta({
    description:
      'Character descriptions extracted from the script for visual consistency',
  }),
  locationBible: z.array(locationBibleEntrySchema).meta({
    description:
      'Location descriptions extracted from the script for visual consistency',
  }),
  elementBible: z.array(elementBibleEntrySchema).meta({
    description:
      'Elements referenced in the script by UPPERCASE token — user-uploaded reference images plus detected recurring products/objects that need a consistent canonical look',
  }),
});

export type SceneSplittingResult = z.infer<typeof sceneSplittingResultSchema>;

/**
 * Music Design + Prompt Generation (combined Phase 7)
 * Classifies each scene's music attributes and synthesizes unified tags + prompt.
 */
export const musicDesignResultSchema = z.object({
  scenes: z
    .array(
      z.object({
        sceneId: z.string().meta({ description: 'Scene identifier' }),
        musicDesign: musicDesignSchema.meta({
          description: 'Music classification for this scene',
        }),
      })
    )
    .meta({ description: 'Per-scene music design classifications' }),
  tags: z.string().meta({
    description:
      'Comma-separated music tags for ACE-Step (must start with "instrumental")',
  }),
  prompt: z.string().meta({
    description:
      '1-2 sentence music prompt describing the overall mood and progression',
  }),
});
