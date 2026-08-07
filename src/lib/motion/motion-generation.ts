import { getEnv } from '#env';
import { estimateFalCost, type EffectiveFalPricing } from '@/lib/ai/fal-cost';
import {
  DEFAULT_VIDEO_MODEL,
  IMAGE_TO_VIDEO_MODELS,
  type ImageToVideoModel,
} from '@/lib/ai/models';
import type { Microdollars } from '@/lib/billing/money';
import { type AspectRatio } from '@/lib/constants/aspect-ratios';
import type { FalCredentialScopedDb } from '@/lib/db/scoped-workflow';
import { MOTION_JSON_SCHEMAS } from '@/lib/motion/endpoint-map';
import {
  getDurationValues,
  numericOf,
  snapTo,
} from '@/lib/motion/motion-transform';
import { generateVideo, getVideoJobStatus } from '@tanstack/ai';
import { falVideo } from '@tanstack/ai-fal';

export type GenerateMotionOptions = {
  scopedDb?: FalCredentialScopedDb; // scopedDb is used to resolve the API key for the motion generation with BYOK
  imageUrl: string;
  prompt: string;
  model?: ImageToVideoModel;
  duration?: number;
  fps?: number;
  motionBucket?: number;
  aspectRatio?: AspectRatio;
  /** For audio-capable models (kling v3, veo3), pass `false` to suppress
   *  the model's native audio output (sfx/ambient/lip-sync). Omitting the
   *  flag lets the API schema default apply (true for audio-capable models). */
  generateAudio?: boolean;
  /**
   * Character + element reference images for identity consistency across the
   * clip (#873). Only emitted for models that accept reference images (Kling
   * v3 Pro, via its `elements` field); ignored by every other model.
   */
  referenceImages?: ReferenceImageDescription[];
};

import { ensureExternallyFetchableUrl } from '@/lib/storage/external-url';
import type { ReferenceImageDescription } from '@/lib/prompts/reference-image-prompt';
import { buildModelInput, buildMotionRequest } from './build-model-input';
import { resolveMotionEndpoint } from './resolve-motion-endpoint';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'motion', 'motion-generation']);

/** Snap a requested duration to the nearest valid value for a model.
 *  Reads supported durations from the model's JSON Schema and snaps directly. */
export function snapDuration(
  requested: number | undefined,
  modelKey: ImageToVideoModel
): number {
  const endpointId = IMAGE_TO_VIDEO_MODELS[modelKey].id;
  const jsonSchema = MOTION_JSON_SCHEMAS[endpointId];
  const validValues = getDurationValues(jsonSchema);

  const firstValue = validValues[0];
  if (firstValue === undefined) return requested ?? 5;

  const target = requested ?? numericOf(firstValue);
  return numericOf(snapTo(target, validValues));
}

export type MotionJobSubmission = {
  jobId: string;
  modelKey: ImageToVideoModel;
  usedOwnKey: boolean;
  submittedAt: number;
};

/**
 * Submit a motion generation job without polling.
 * Returns the job ID so the workflow can poll with `context.sleep()` between steps.
 */
export async function submitMotionJob(
  options: GenerateMotionOptions
): Promise<MotionJobSubmission> {
  const modelKey = options.model || DEFAULT_VIDEO_MODEL;
  const modelConfig = IMAGE_TO_VIDEO_MODELS[modelKey];

  // Resolve the API key for the motion generation with BYOK if available.
  // Resolved BEFORE normalizing the image URL: the fal-storage upload below
  // authenticates with this key, so on a BYOK-only deployment (no platform
  // FAL_KEY) the platform key would be empty and the upload would fail with
  // "Authorization header is required" before submission (#924).
  const falApiKeyInfo = options.scopedDb
    ? await options.scopedDb.resolveKey('fal')
    : { key: getEnv().FAL_KEY, source: 'platform' as const };

  // Locally-served /r2/ image URLs aren't reachable by real fal — swap them
  // for a fal-storage upload first (no-op in prod and e2e replay).
  const imageUrl = await ensureExternallyFetchableUrl(
    options.imageUrl,
    falApiKeyInfo.key
  );

  // Decide which endpoint this run submits to (#873). With cast/element refs,
  // models that have a dedicated reference-to-video endpoint (Seedance) route
  // there; everything else (incl. Kling, which carries refs inline as
  // `elements`) stays on its image-to-video endpoint.
  const hasReferenceImages = (options.referenceImages?.length ?? 0) > 0;
  const endpoint = resolveMotionEndpoint(modelKey, hasReferenceImages);

  // Reference images are emitted either inline (Kling's `elements`) or via the
  // reference-to-video endpoint (Seedance). Both paths need externally-fetchable
  // URLs — the same locally-served /r2/ swap imageUrl needs applies to the
  // character sheets / element images. Models that don't emit refs keep the raw
  // references: their URLs are never sent, but the builder still needs the
  // tokens + descriptions to substitute entity tokens in the prompt.
  const emitsReferences =
    endpoint.usesReferenceEndpoint || modelKey === 'kling_v3_pro';
  const referenceImages =
    emitsReferences && options.referenceImages?.length
      ? await Promise.all(
          options.referenceImages.map(async (ref) => ({
            ...ref,
            referenceImageUrl: await ensureExternallyFetchableUrl(
              ref.referenceImageUrl
            ),
          }))
        )
      : options.referenceImages;

  // Prepare the model input — the reference-to-video endpoint has a different
  // input shape (tagged image_urls[], no start-frame image_url). Shared with
  // the scene editor's optimised-prompt preview via buildMotionRequest.
  const optionsWithFetchableUrls = { ...options, imageUrl, referenceImages };
  const modelInput = buildMotionRequest(
    optionsWithFetchableUrls,
    modelKey
  ).input;

  // Separate the prompt from the model options
  const { prompt: optimisedPrompt, ...modelOptions } = modelInput;
  if (typeof optimisedPrompt !== 'string') {
    throw new Error('Truncated prompt is not a string');
  }
  // Log the submission details
  logger.info(`Submitting job with model: ${modelConfig.id}`, {
    provider: modelConfig.provider,
    endpoint: endpoint.endpointId,
    promptLength: optimisedPrompt.length,
    modelOptions,
  });

  // Create the Tanstack AI adapter and submit the job
  // Note this is typesafe - only options compatible with modelConfig.id are allowed
  // Important: fal.ai supports string for model ids that the client doesn't know about - so most new models _aren't_ typesafe
  const job = await generateVideo({
    adapter: falVideo(endpoint.endpointId, {
      apiKey: falApiKeyInfo.key,
    }),
    prompt: optimisedPrompt,
    modelOptions,
    debug: false,
  });

  // Log the job submission details
  logger.info(`Job submitted: ${job.jobId}`);

  return {
    jobId: job.jobId,
    modelKey,
    usedOwnKey: falApiKeyInfo.source === 'team',
    submittedAt: Date.now(),
  };
}

/**
 * Check the status of a submitted motion job.
 * Designed to be called from individual workflow steps.
 */
export async function pollMotionJob(
  jobId: string,
  modelKey: ImageToVideoModel,
  scopedDb?: FalCredentialScopedDb
) {
  const modelConfig = IMAGE_TO_VIDEO_MODELS[modelKey];

  // Resolve the API key for the motion generation with BYOK if available
  const falApiKeyInfo = scopedDb
    ? await scopedDb.resolveKey('fal')
    : { key: getEnv().FAL_KEY, source: 'platform' as const };

  // Create the Tanstack AI adapter and poll the job status

  return await getVideoJobStatus({
    adapter: falVideo(modelConfig.id, {
      apiKey: falApiKeyInfo.key,
    }),
    jobId,
  });
}

/**
 * Pre-flight motion cost estimate + metadata, computed before the job runs.
 * `cost` is a rough estimate for the credit gate (null = no honest estimate;
 * gate with `gateEstimate`) — the exact charge comes from `falCostFromUnits`
 * once fal reports `unitsBilled`. Pass `getEffectiveFalPricing()` as
 * `pricing` on server paths.
 */
export function calculateMotionMetadata(
  options: GenerateMotionOptions,
  pricing: Record<string, EffectiveFalPricing>
): {
  cost: Microdollars | null;
  duration: number;
  model: string;
  provider: string;
} {
  const modelKey = options.model || DEFAULT_VIDEO_MODEL;
  const modelConfig = IMAGE_TO_VIDEO_MODELS[modelKey];

  const validatedDuration = snapDuration(options.duration, modelKey);

  const providerInput = buildModelInput(options, modelConfig, modelKey);
  const cost = estimateFalCost(
    modelConfig.id,
    {
      durationSeconds: validatedDuration,
      resolution:
        'resolution' in providerInput &&
        typeof providerInput.resolution === 'string'
          ? providerInput.resolution
          : undefined,
    },
    pricing
  );

  return {
    cost,
    duration: validatedDuration,
    model: modelConfig.id,
    provider: modelConfig.provider,
  };
}

type FalQueueStatus = {
  status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED';
  queue_position?: number;
  response_url?: string;
  cancel_url?: string;
  status_url?: string;
  logs?: Array<{ level: string; message: string }>;
  metrics?: { inference_time?: number };
};

/** Authenticated fetch against the fal queue API */
async function falQueueFetch(
  url: string,
  init?: RequestInit
): Promise<Response> {
  const apiKey = getEnv().FAL_KEY;
  if (!apiKey) {
    throw new Error('FAL_KEY environment variable is required');
  }

  const response = await fetch(url, {
    ...init,
    headers: new Headers({
      Authorization: `Key ${apiKey}`,
      ...Object.fromEntries(new Headers(init?.headers).entries()),
    }),
  });

  if (!response.ok) {
    throw new Error(`Fal API error: ${response.status} ${response.statusText}`);
  }

  return response;
}

export async function checkMotionStatus(
  statusUrl: string
): Promise<FalQueueStatus> {
  const response = await falQueueFetch(statusUrl);
  return response.json();
}

export async function getMotionResult(
  responseUrl: string
): Promise<{ video: { url: string } }> {
  const response = await falQueueFetch(responseUrl);
  return response.json();
}

export async function cancelMotionGeneration(cancelUrl: string): Promise<void> {
  await falQueueFetch(cancelUrl, { method: 'PUT' });
}
