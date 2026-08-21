/**
 * Orchestration for the public `/api/v1/styles` collection (#1227): create a
 * team-owned library style (from a prose brief via one billed LLM call, or
 * from a ready v2 config), plus the reads that let an agent reuse what it made.
 *
 *   brief → LLM (style/from-brief-chat) → autoStyleDraftFromResponse
 *   config → StyleConfigSchema (already validated by the input schema)
 *   → scopedDb.styles.create (slug-unique per team, server-managed columns stripped)
 *
 * Server-only: imports the AI stack via `@/functions/ai`. Kept separate from
 * `style-input-schema.ts` so discovery/OpenAPI can import the schema alone.
 */

import { prepareBilling } from '@/functions/ai';
import {
  callLLMStream,
  llmCostFromUsage,
  RECOMMENDED_MODELS,
} from '@/lib/ai/llm-client';
import type { ScopedDb } from '@/lib/db/scoped';
import type { Style } from '@/lib/db/schema/libraries';
import { ValidationError } from '@/lib/errors';
import { getChatPrompt } from '@/lib/prompts';
import {
  autoStyleDraftFromResponse,
  autoStyleResponseSchema,
  type AutoStyleDraft,
} from '@/lib/style/auto-style';
import { parseStyleConfig } from '@/lib/style/style-config';
import { createSequenceLink, listStylesLink } from './discovery';
import { getLink, STYLES_PATH, type HalResource, withLinks } from './hal';
import type { ApiCreateStyleInput } from './style-input-schema';

/** Narrowed to what this module touches, so tests can stub it without casts. */
export type StyleContext = {
  scopedDb: Pick<ScopedDb, 'apiKeys' | 'billing'> & {
    styles: Pick<ScopedDb['styles'], 'create'>;
  };
  user: { id: string };
  teamId: string;
};

/** Compact card for the list endpoint. */
export type StyleCard = {
  id: string;
  name: string;
  category: string | null;
  tags: string[];
  isTemplate: boolean;
};

/** Full document for create/get. */
export type StyleDocument = StyleCard & {
  description: string | null;
  useCases: string[];
  defaultAspectRatio: string | null;
  recommendedImageModel: string | null;
  recommendedVideoModel: string | null;
  previewUrl: string | null;
  config: ReturnType<typeof parseStyleConfig>;
  createdAt: string;
};

export function styleCard(style: Style): HalResource<StyleCard> {
  return withLinks(
    {
      id: style.id,
      name: style.name,
      category: style.category,
      tags: style.tags ?? [],
      isTemplate: style.isTemplate ?? false,
    },
    { self: getLink(`${STYLES_PATH}/${style.id}`, 'Full style document') }
  );
}

export function styleDocument(style: Style): HalResource<StyleDocument> {
  const card = styleCard(style);
  return withLinks(
    {
      ...card,
      description: style.description,
      useCases: style.useCases ?? [],
      defaultAspectRatio: style.defaultAspectRatio,
      recommendedImageModel: style.recommendedImageModel,
      recommendedVideoModel: style.recommendedVideoModel,
      previewUrl: style.previewUrl,
      config: parseStyleConfig(style.config),
      createdAt: style.createdAt.toISOString(),
    },
    {
      ...card._links,
      'create-sequence': {
        ...createSequenceLink(),
        title: 'Create a video sequence in this style',
        examples: [
          {
            script: 'A lighthouse keeper befriends a stranded whale.',
            style: style.id,
          },
        ],
      },
      'list-styles': listStylesLink(),
    }
  );
}

/**
 * Turn a prose brief into a style recipe with one billed structured LLM call —
 * the same response schema + coercion the automatic (script-derived) style
 * uses, so both paths produce identical `StyleConfig` shapes.
 */
async function draftFromBrief(
  brief: string,
  ctx: StyleContext
): Promise<AutoStyleDraft> {
  const model = RECOMMENDED_MODELS.structured;
  const { llmKey, deduct } = await prepareBilling(
    ctx.scopedDb,
    'Style from brief',
    { model }
  );
  const { messages } = await getChatPrompt('style/from-brief-chat', { brief });

  let response;
  let usage;
  for await (const chunk of callLLMStream({
    model,
    messages,
    observationName: 'styleFromBrief',
    userId: ctx.user.id,
    responseSchema: autoStyleResponseSchema,
    apiKey: llmKey,
  })) {
    if (chunk.done) {
      response = chunk.parsed;
      usage = chunk.usage;
    }
  }
  if (!response) {
    throw new Error('No response received from AI service');
  }
  await deduct?.(llmCostFromUsage(usage, model));
  return autoStyleDraftFromResponse(response);
}

export async function createStyle(
  input: ApiCreateStyleInput,
  ctx: StyleContext
): Promise<Style> {
  // Schema XOR: exactly one of brief/config is present.
  const derived =
    input.config === undefined && input.brief !== undefined
      ? await draftFromBrief(input.brief, ctx)
      : undefined;
  const config = input.config ?? derived?.config;
  if (!config) {
    throw new ValidationError('Provide exactly one of "brief" or "config".');
  }

  return ctx.scopedDb.styles.create({
    name: input.name,
    description: input.description ?? derived?.description ?? null,
    category: input.category ?? derived?.category ?? null,
    tags: input.tags ?? derived?.tags ?? [],
    useCases: input.useCases ?? [],
    defaultAspectRatio: input.defaultAspectRatio ?? null,
    recommendedImageModel: input.recommendedImageModel ?? null,
    recommendedVideoModel: input.recommendedVideoModel ?? null,
    config,
  });
}
