/**
 * AI Server Functions
 * End-to-end type-safe functions for AI operations
 */

import { getEnv } from '#env';
import { mediaUrlSchema } from '@/lib/schemas/media-url.schemas';
import {
  callLLM,
  callLLMStream,
  PROMPT_REASONING,
  RECOMMENDED_MODELS,
} from '@/lib/ai/llm-client';
import { isValidAnalysisModelId } from '@/lib/ai/models.config';
import {
  checkForInjectionAttempts,
  sanitizeScriptContent,
} from '@/lib/ai/prompt-validation';
import {
  createUserPrompt,
  RateLimiter,
  scriptEnhancementRateLimiter,
} from '@/lib/ai/script-enhancer';
import { estimateLLMCost } from '@/lib/billing/cost-estimation';
import { aspectRatioSchema } from '@/lib/constants/aspect-ratios';
import { StyleConfigSchema } from '@/lib/db/schema/libraries';
import type { ScopedDb } from '@/lib/db/scoped';
import type { ResolvedLlmKey } from '@/lib/db/scoped/api-keys';
import { InsufficientCreditsError } from '@/lib/errors';
import {
  getPrompt,
  type ChatMessage,
  type ChatMessageContentPart,
} from '@/lib/prompts';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { toVisionImageSource } from '@/lib/storage/external-url';
import { createServerFn, createServerOnlyFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithTeamMiddleware, shotAccessMiddleware } from './middleware';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'serverFn', 'ai']);

const promptShorteningRateLimiter = new RateLimiter(10, 60_000);
const sceneDurationEstimationRateLimiter = new RateLimiter(20, 60_000);

const SHORTEN_PROMPT_SYSTEM = `You are an expert at condensing image generation prompts while preserving all critical visual elements.

Your task is to shorten image prompts by:
- Removing verbose descriptions and redundant words
- Keeping essential visual elements: subjects, composition, style, lighting, mood
- Maintaining technical parameters (aspect ratio, quality, etc.)
- Preserving artistic style references and specific details
- Using concise, impactful language

Target 50-75% reduction in length while keeping the prompt's core meaning intact.

Return ONLY the shortened prompt text, nothing else. No explanations, no preamble.`;

function getClientIP(): string {
  const request = getRequest();
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0] ||
    request.headers.get('x-real-ip') ||
    'anonymous'
  );
}

function enforceRateLimit(limiter: RateLimiter, key: string): void {
  if (limiter.isAllowed(key)) return;
  const remainingMs = limiter.getRemainingTime(key);
  throw new Error(
    `Rate limit exceeded. Please try again in ${Math.ceil(remainingMs / 1000)} seconds.`
  );
}

/**
 * Check pre-flight billing and resolve the key for the LLM call.
 * `deduct` is undefined when billing is skipped — the team's own key pays,
 * either their OpenRouter key or their fal key routed through fal's
 * OpenRouter endpoint (issue #895).
 */
async function prepareBilling(
  scopedDb: ScopedDb,
  description: string,
  metadata?: Record<string, unknown>
): Promise<{ llmKey: ResolvedLlmKey; deduct?: () => Promise<void> }> {
  const llmKey = await scopedDb.apiKeys.resolveLlmKey();
  if (llmKey.source === 'team') return { llmKey };

  const cost = estimateLLMCost(1);
  const canAfford = await scopedDb.billing.hasEnoughCredits(cost);
  if (!canAfford) {
    throw new InsufficientCreditsError(
      `Insufficient credits for ${description.toLowerCase()}`
    );
  }

  return {
    llmKey,
    deduct: async () => {
      if (cost > 0) {
        await scopedDb.billing.deductCredits(cost, {
          description,
          metadata,
        });
      }
    },
  };
}

// -- Shorten Prompt --

const shortenPromptInputSchema = z.object({
  prompt: z
    .string()
    .min(20, 'Prompt must be at least 20 characters')
    .max(5000, 'Prompt too long'),
});

export const shortenPromptFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(zodValidator(shortenPromptInputSchema))
  .handler(async ({ data, context }) => {
    enforceRateLimit(promptShorteningRateLimiter, getClientIP());

    const { llmKey, deduct } = await prepareBilling(
      context.scopedDb,
      `Prompt shortening (${RECOMMENDED_MODELS.fast})`,
      { model: RECOMMENDED_MODELS.fast }
    );

    const shortenedPrompt = await callLLM({
      model: RECOMMENDED_MODELS.fast,
      messages: [
        { role: 'system' as const, content: SHORTEN_PROMPT_SYSTEM },
        { role: 'user' as const, content: data.prompt },
      ],
      max_tokens: 500,
      temperature: 0.3,
      observationName: 'shortenPrompt',
      userId: context.user.id,
      apiKey: llmKey,
    });

    await deduct?.();

    if (!shortenedPrompt) {
      throw new Error('No response received from AI service');
    }

    const trimmedPrompt = shortenedPrompt.trim();
    if (trimmedPrompt.length < 20) {
      throw new Error('Shortened prompt is too short. Please try again.');
    }

    return {
      originalPrompt: data.prompt,
      shortenedPrompt: trimmedPrompt,
      originalLength: data.prompt.length,
      shortenedLength: trimmedPrompt.length,
      reductionPercent: Math.round(
        ((data.prompt.length - trimmedPrompt.length) / data.prompt.length) * 100
      ),
    };
  });

// -- Estimate Scene Duration --

const ESTIMATE_SCENE_DURATION_SYSTEM = `You estimate how many seconds a single scene runs as a short-form video clip. Default to short — most scenes are 3-6 seconds.

Honor explicit duration cues in the script. If the script text references a length (e.g. "10 second clip", "5s", "for thirty seconds", "a brief two-second beat"), use that number directly.

Otherwise:
- Pure visual / establishing shot, no dialogue → 3-4
- Single short action or reaction beat → 4-5
- One spoken line → time the dialogue at ~200 spoken words per minute and add 1 second of breathing room
- Multiple actions or lines → sum the components

Avoid generous padding. Reach 10+ seconds only when the script clearly demands it. Never invent visual moments that aren't in the script.

Return ONLY valid JSON: {"durationSeconds": <integer between 1 and 60>}.`;

// Schema sent to the LLM as the structured-output JSON Schema. Use plain
// `z.number()` rather than `.int()` / `.min()` / `.max()` — Zod injects
// JS-safe-integer bounds for `.int()`, and Amazon Bedrock (one of the
// OpenRouter providers for Sonnet) rejects ANY `minimum`/`maximum` on
// integer types: "For 'integer' type, properties maximum, minimum are not
// supported". Range + integer enforcement happen post-parse via clamp.
const sceneDurationResponseSchema = z.object({
  durationSeconds: z.number(),
});

const SCENE_DURATION_MIN = 1;
const SCENE_DURATION_MAX = 60;
const clampDuration = (n: number) =>
  Math.min(SCENE_DURATION_MAX, Math.max(SCENE_DURATION_MIN, Math.round(n)));

const estimateSceneDurationInputSchema = z.object({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
  extract: z
    .string()
    .min(1, 'Scene script is empty')
    .max(5000, 'Scene script too long for estimation'),
});

export const estimateSceneDurationFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .inputValidator(zodValidator(estimateSceneDurationInputSchema))
  .handler(async ({ data, context }) => {
    enforceRateLimit(sceneDurationEstimationRateLimiter, getClientIP());

    const analysisModel =
      (isValidAnalysisModelId(context.sequence.analysisModel)
        ? context.sequence.analysisModel
        : null) ?? RECOMMENDED_MODELS.fast;

    const { llmKey, deduct } = await prepareBilling(
      context.scopedDb,
      `Scene duration estimate (${analysisModel})`,
      { model: analysisModel, shotId: context.shot.id }
    );

    const sceneMetadata = context.shot.metadata?.metadata;
    const userPrompt = [
      sceneMetadata?.title && `Title: ${sceneMetadata.title}`,
      sceneMetadata?.location && `Location: ${sceneMetadata.location}`,
      sceneMetadata?.timeOfDay && `Time of day: ${sceneMetadata.timeOfDay}`,
      sceneMetadata?.storyBeat && `Story beat: ${sceneMetadata.storyBeat}`,
      '',
      'Script:',
      data.extract,
    ]
      .filter(Boolean)
      .join('\n');

    const response = await callLLM({
      model: analysisModel,
      messages: [
        { role: 'system' as const, content: ESTIMATE_SCENE_DURATION_SYSTEM },
        { role: 'user' as const, content: userPrompt },
      ],
      max_tokens: 50,
      temperature: 0.2,
      observationName: 'estimateSceneDuration',
      userId: context.user.id,
      responseSchema: sceneDurationResponseSchema,
      apiKey: llmKey,
    });

    await deduct?.();

    return { durationSeconds: clampDuration(response.durationSeconds) };
  });

// -- Enhance Script --

const enhanceScriptInputSchema = z.object({
  script: z
    .string()
    .min(10, 'Script must be at least 10 characters')
    .max(50000, 'Script too long'),
  targetDuration: z.number().min(5).max(180).optional(),
  // The chosen style, narrowed to what the enhancer reads: the aesthetic recipe
  // (`config`) drives the LOOK; name/category/tags drive WHAT HAPPENS. One
  // cohesive object — built by `toEnhanceInputs` so the UI and API match.
  style: z
    .object({
      config: StyleConfigSchema.partial().optional(),
      name: z.string().optional(),
      category: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      tags: z.array(z.string()).nullable().optional(),
    })
    .optional(),
  analysisModel: z.string().optional(),
  aspectRatio: aspectRatioSchema.optional(),
  elements: z
    .array(
      z.object({
        token: z.string().min(1),
        description: z.string().nullable().optional(),
        imageUrl: mediaUrlSchema,
      })
    )
    .optional(),
});

export type EnhanceScriptInput = z.infer<typeof enhanceScriptInputSchema>;

/**
 * Core script-enhancement generator, shared by the streaming server function
 * (which yields deltas to the browser) and the public API's one-shot create
 * flow (which drains it to a full string). Single source of truth for billing,
 * sanitization, and the prompt/model choice.
 *
 * Note: this is a *server-only* helper but lives in a module the client imports
 * (for the `enhanceScriptStreamFn` stub). It must NOT reference request-scoped
 * server-only APIs (e.g. `getRequest`/`getClientIP`) at this level, or the
 * import-protection plugin will pull them into the client bundle. IP
 * rate-limiting therefore lives in the serverFn handler below; the public API
 * path is throttled by its per-key rate limit instead.
 */
export async function* streamScriptEnhancement(
  data: EnhanceScriptInput,
  ctx: { scopedDb: ScopedDb; userId: string; teamId: string }
): AsyncGenerator<{ delta: string }> {
  const { llmKey, deduct } = await prepareBilling(
    ctx.scopedDb,
    'Script enhancement'
  );

  if (checkForInjectionAttempts(data.script)) {
    logger.warn('Script enhancement: Potential injection attempt detected');
  }

  const sanitized = sanitizeScriptContent(data.script);
  const { compiled } = await getPrompt('script/enhance');
  const elements = data.elements ?? [];
  const userPrompt = createUserPrompt(sanitized, {
    style: data.style,
    aspectRatio: data.aspectRatio,
    targetDuration: data.targetDuration,
    elements: elements.length > 0 ? elements : undefined,
  });

  const model =
    data.analysisModel && isValidAnalysisModelId(data.analysisModel)
      ? data.analysisModel
      : RECOMMENDED_MODELS.creative;

  const systemMessage = `${compiled}\n\nReturn ONLY the enhanced script text. No JSON, no markdown formatting, no explanations.`;

  // Element images must be made externally fetchable before the LLM call: in
  // local dev they're `http://localhost/r2/…` URLs that only resolve on this
  // machine, so providers can't fetch them. toVisionImageSource inlines those as
  // base64 data parts and passes externally-reachable URLs through (it gates on
  // local-serve mode, not the URL scheme) — the same shim the element-vision
  // call already uses. A failed/expired image aborts the whole enhance, so log
  // which element broke before rethrowing: the raw "Failed to read local storage
  // object …" is otherwise undiagnosable.
  const imageParts = await Promise.all(
    elements.map<Promise<ChatMessageContentPart>>(async (el) => {
      try {
        return {
          type: 'image',
          source: await toVisionImageSource(el.imageUrl),
        };
      } catch (cause) {
        logger.error('Script enhancement: failed to load element image', {
          token: el.token,
          imageUrl: el.imageUrl,
          teamId: ctx.teamId,
          userId: ctx.userId,
          error: cause instanceof Error ? cause.message : String(cause),
        });
        throw new Error(
          `Couldn't load element image "${el.token}" for script enhancement`,
          { cause }
        );
      }
    })
  );
  const userContent: string | ChatMessageContentPart[] =
    elements.length > 0
      ? [{ type: 'text', content: userPrompt }, ...imageParts]
      : userPrompt;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemMessage },
    { role: 'user', content: userContent },
  ];

  // Web search runs as OpenRouter's server tool — the model decides when to
  // search and OpenRouter executes it server-side within the agent loop.
  // Gate it out of E2E entirely (record + replay): live search results would
  // make the recorded OpenRouter request/response non-deterministic. Reasoning
  // is NOT gated — it's deterministic once recorded, so E2E records + replays
  // it like any other request.
  const useWebSearch = getEnv().E2E_TEST !== 'true';
  for await (const chunk of callLLMStream({
    model,
    messages,
    // No max_tokens: every model routes through OpenRouter, which falls back
    // to the model's own max output when the field is omitted — so long
    // scripts use the full available output budget instead of an artificial
    // cap. Reasoning (PROMPT_REASONING, medium) shares the completion budget,
    // but the per-model default is far larger than any realistic script, so
    // the #915 truncation (seen when this was a flat 4000) can't recur.
    temperature: 0.7,
    ...(useWebSearch && { webSearch: true }),
    reasoning: PROMPT_REASONING,
    observationName: 'script-enhance',
    tags: ['script-enhance', model],
    userId: ctx.userId,
    apiKey: llmKey,
    metadata: {
      teamId: ctx.teamId,
      elementCount: elements.length,
      targetDuration: data.targetDuration,
      aspectRatio: data.aspectRatio,
    },
  })) {
    if (chunk.delta) {
      yield { delta: chunk.delta };
    }
  }

  await deduct?.();
}

/**
 * Run script enhancement to completion and return the full enhanced text.
 * Used by the public API where there is no client streaming channel.
 */
export const enhanceScriptToString = createServerOnlyFn(
  async (
    data: EnhanceScriptInput,
    ctx: { scopedDb: ScopedDb; userId: string; teamId: string }
  ): Promise<string> => {
    let enhanced = '';
    for await (const { delta } of streamScriptEnhancement(data, ctx)) {
      enhanced += delta;
    }
    return enhanced.trim();
  }
);

export const enhanceScriptStreamFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(zodValidator(enhanceScriptInputSchema))
  .handler(async function* ({ data, context }) {
    // IP rate-limit the dashboard path here (kept out of the shared core so the
    // core stays free of request-scoped server-only APIs — see note above).
    enforceRateLimit(scriptEnhancementRateLimiter, getClientIP());
    yield* streamScriptEnhancement(data, {
      scopedDb: context.scopedDb,
      userId: context.user.id,
      teamId: context.teamId,
    });
  });
