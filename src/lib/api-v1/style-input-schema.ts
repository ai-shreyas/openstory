/**
 * Public request schema for `POST /api/v1/styles` — create a team-owned
 * library style. Exactly one of `brief` (prose → billed LLM derives the
 * recipe) or `config` (a ready v2 `StyleConfig`, no LLM) must be given.
 *
 * Drizzle-free so discovery/OpenAPI can import it. Server-managed columns
 * (`isPublic`, `isTemplate`, `sequenceId`, `usageCount`, `sortOrder`,
 * `version`, …) are simply absent here; the scoped-db layer strips them again.
 */

import { aspectRatioSchema } from '@/lib/constants/aspect-ratios';
import { StyleConfigSchema } from '@/lib/style/style-config';
import { z } from 'zod';

const tagList = z.array(z.string().trim().min(1).max(60)).max(20);

export const apiCreateStyleSchema = z
  .object({
    name: z.string().trim().min(1).max(255).meta({
      description:
        'Style name (unique per team — its URL slug must not collide with an existing library style).',
    }),
    description: z.string().trim().max(1000).optional().meta({
      description:
        'One-line card description. Derived from the brief if omitted.',
    }),
    category: z.string().trim().min(1).max(100).optional().meta({
      description:
        'Catalog category (film, commercial, ecommerce, influencer, animatic, animation, kids, tech). Derived from the brief if omitted.',
    }),
    tags: tagList.optional().meta({
      description: 'Lowercase keywords. Derived from the brief if omitted.',
    }),
    useCases: tagList.optional(),
    defaultAspectRatio: aspectRatioSchema.optional(),
    recommendedImageModel: z.string().trim().min(1).optional(),
    recommendedVideoModel: z.string().trim().min(1).optional(),
    brief: z.string().trim().min(10).max(5000).optional().meta({
      description:
        'Prose describing the look and motion you want. A billed LLM call turns it into a full style recipe.',
    }),
    config: StyleConfigSchema.optional().meta({
      description:
        'A complete v2 style recipe. Skips the LLM; validated as-is (v1 configs are not accepted).',
    }),
  })
  .refine((v) => (v.brief === undefined) !== (v.config === undefined), {
    message: 'Provide exactly one of "brief" or "config".',
    path: ['brief'],
  });

export type ApiCreateStyleInput = z.infer<typeof apiCreateStyleSchema>;
