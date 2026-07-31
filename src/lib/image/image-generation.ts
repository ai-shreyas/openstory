import { falCostFromUnits } from '@/lib/ai/fal-cost';
import { extractFalErrorMessage } from '@/lib/ai/fal-error';
import { type Microdollars, microsToUsd } from '@/lib/billing/money';
import {
  buildImageRequest,
  type ImageGenerationParams,
} from '@/lib/image/build-image-request';
import {
  endSpanError,
  endSpanSuccess,
  startGenAISpan,
} from '@/lib/observability/tracer';

import { getEnv } from '#env';
import type { ScopedDb } from '@/lib/db/scoped';
import { ensureExternallyFetchableUrls } from '@/lib/storage/external-url';
import { generateImage } from '@tanstack/ai';
import { falImage } from '@tanstack/ai-fal';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'image', 'image-generation']);

export type { ImageGenerationParams } from '@/lib/image/build-image-request';

/** Non-serializable options passed separately from ImageGenerationParams */
export type ImageGenerationOptions = {
  scopedDb?: ScopedDb;
  onQueueUpdate?: (update: {
    status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
    logs?: string[];
    progress?: number;
  }) => void;
  /** User id for span attribution (Langfuse user.id, PostHog distinct_id) */
  userId?: string;
  /** Session id for Langfuse trace grouping (typically sequenceId) */
  sessionId?: string;
};

export type ImageGenerationResult = {
  imageUrls: string[];
  parameters: ImageGenerationParams;
  generatedAt: string;
  processingTimeMs: number;
  provider: 'fal';
  metadata: {
    prompt: string;
    model: string;
    /** Fal endpoint actually submitted to (billing denominator). */
    endpointId: string;
    /** Fal-reported billed unit count. Recorded as a `model_usage_observations`
     * sample (the pricing cron's median reads that table, not the credit
     * ledger) and also spread into the transaction metadata as a billing
     * trail — see `recordFalUsageStep` (#1069). */
    unitsBilled?: number;
    /** Images this one call rendered. `unitsBilled` covers all of them, so the
     * cron divides by it to get a per-image median (#1069). */
    numImages?: number;
    dimensions: { width: number; height: number }[];
    file_sizes: number[];
    seed?: number;
    has_nsfw_concepts?: boolean[];
    cost?: Microdollars;
    requestId?: string;
    usedOwnKey: boolean;
  };
};

function createFalAdapter(modelId: string, falApiKey?: string) {
  const key = falApiKey ?? getEnv().FAL_KEY;
  return key ? falImage(modelId, { apiKey: key }) : falImage(modelId);
}

export async function generateImageWithProvider(
  params: ImageGenerationParams,
  options?: ImageGenerationOptions
): Promise<ImageGenerationResult> {
  const span = startGenAISpan(params.traceName ?? 'fal-image', {
    model: params.model,
    provider: 'fal',
    operation: 'generate_content',
    userId: options?.userId,
    sessionId: options?.sessionId,
    input: {
      prompt: params.prompt,
      imageSize: params.imageSize,
      ...(params.referenceImageUrls?.length && {
        referenceImageUrls: params.referenceImageUrls,
      }),
    },
  });

  try {
    const result = await generateImageInternal(params, options);

    if (result.metadata.cost) {
      span.setAttribute('gen_ai.usage.cost', microsToUsd(result.metadata.cost));
    }
    endSpanSuccess(span, { imageUrls: result.imageUrls });
    return result;
  } catch (error) {
    const errorMessage = extractFalErrorMessage(error);
    endSpanError(span, errorMessage);

    // Re-throw with the full detail so workflow failure handlers get the real message
    if (errorMessage !== (error instanceof Error ? error.message : '')) {
      throw new Error(errorMessage, { cause: error });
    }
    throw error;
  }
}
// @TODO: TB Mar 2026 - this needs to be updated to be typesafe. Especially after the work put in on Tanstack AI to keep it safe
async function generateImageInternal(
  rawParams: ImageGenerationParams,
  options?: ImageGenerationOptions
): Promise<ImageGenerationResult> {
  // Get the fal API key - byok or global. Resolved BEFORE normalizing
  // reference URLs: the fal-storage upload below authenticates with this key,
  // so on a BYOK-only deployment (no platform FAL_KEY) the platform key would
  // be empty and the upload would fail with "Authorization header is required"
  // before we ever reach generation (#924).
  const falApiKeyInfo = options?.scopedDb
    ? await options.scopedDb.apiKeys.resolveKey('fal')
    : { key: getEnv().FAL_KEY, source: 'platform' as const };

  // Locally-served /r2/ reference URLs aren't reachable by real fal — swap
  // them for fal-storage uploads first (no-op in prod and e2e replay).
  const params: ImageGenerationParams = rawParams.referenceImageUrls?.length
    ? {
        ...rawParams,
        referenceImageUrls: await ensureExternallyFetchableUrls(
          rawParams.referenceImageUrls,
          falApiKeyInfo.key
        ),
      }
    : rawParams;
  const startTime = Date.now();

  // The exact request fal receives — shared with the scene editor's
  // optimised-prompt preview so the two can never drift.
  const { endpointId: endpoint, input } = buildImageRequest(params);
  const { prompt, ...modelOptions } = input;

  const adapter = createFalAdapter(endpoint, falApiKeyInfo.key);

  logger.info('generateImage request', {
    data: JSON.stringify(
      {
        model: params.model,
        endpoint,
        keySource: falApiKeyInfo.source,
        prompt,
        modelOptions,
        referenceImageUrls: params.referenceImageUrls ?? [],
      },
      null,
      2
    ),
  });

  const result = await generateImage({
    adapter,
    prompt,
    modelOptions,
    debug: false,
  });

  logger.info('generateImage response', {
    data: JSON.stringify(
      {
        model: params.model,
        endpoint,
        imageUrls: result.images.map((img) => img.url),
      },
      null,
      2
    ),
  });

  const imageUrls = result.images
    .map((img) => img.url)
    .filter((url): url is string => !!url);

  if (imageUrls.length === 0) {
    throw new Error('No images returned from generation');
  }

  const processingTimeMs = Date.now() - startTime;

  // Exact cost from fal's reported billed units (resolution/style premiums are
  // already baked into the count by fal).
  const cost = await falCostFromUnits(endpoint, result.usage?.unitsBilled);

  return {
    imageUrls,
    parameters: params,
    generatedAt: new Date().toISOString(),
    processingTimeMs,
    provider: 'fal',
    metadata: {
      prompt: params.prompt,
      model: params.model,
      endpointId: endpoint,
      unitsBilled: result.usage?.unitsBilled,
      // What the call actually returned, not what it was asked for: the median
      // divides `unitsBilled` by this, so a partial return (3 of 4 images)
      // recorded as 4 biases the per-image figure LOW — the direction that
      // under-gates, which is #1069's failure mode (#1069).
      numImages: imageUrls.length || params.numImages,
      dimensions: imageUrls.map(() => ({ width: 0, height: 0 })),
      file_sizes: imageUrls.map(() => 0),
      seed: params.seed,
      cost,
      // The adapter sets `id` to fal's request id — the join key to the
      // billing-events record the hourly reconcile audits this charge against.
      requestId: result.id,
      usedOwnKey: falApiKeyInfo.source === 'team',
    },
  };
}
