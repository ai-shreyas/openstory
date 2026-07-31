/**
 * Cost estimation for pre-flight credit gates. Returns Microdollars, or null
 * when no honest estimate exists (#1069; see `estimateFalCost`).
 *
 * `pricing` is REQUIRED on every estimator — server paths pass
 * `getEffectiveFalPricing()`, tests pass a fixture. A default would let a
 * call site silently estimate on stale data. Estimators stay synchronous.
 */

import { estimateFalCost, type EffectiveFalPricing } from '@/lib/ai/fal-cost';
import {
  AUDIO_MODELS,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
  type AudioModel,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import { aspectRatioToDimensions } from '@/lib/constants/aspect-ratios';
import { getLogger } from '@/lib/observability/logger';
import { reportFlooredEstimate } from './billing-observability';
import { type Microdollars, addMicros, micros, multiplyMicros } from './money';

const logger = getLogger(['openstory', 'billing', 'cost-estimation']);

type FalPricingMap = Record<string, EffectiveFalPricing>;

/**
 * Conservative per-call floor the credit gate assumes when a model has no
 * honest estimate. Over-gating slightly beats under-gating — the old
 * fabricated default gated Grok Imagine ~98× low (#1069). A model leaves the
 * floor once `MIN_OBSERVED_SAMPLES` generations are recorded AND the nightly
 * cron folds them into `model_pricing` (~5 generations + up to 24h).
 */
const UNKNOWN_ESTIMATE_FLOOR = micros(100_000); // $0.10 per call

/**
 * Operations that can gate on the unknown-estimate floor. A closed union: the
 * value is both the `reportedUnpriced` dedup key and the log-grouping
 * dimension, so a typo would fork both.
 */
type GateOperation =
  | 'add-audio-model'
  | 'add-image-model'
  | 'add-video-model'
  | 'batch-motion'
  | 'motion'
  | 'motion-workflow'
  | 'shot-image'
  | 'shot-variants'
  | 'smart-retry:image'
  | 'smart-retry:motion'
  | 'storyboard:character-sheets'
  | 'storyboard:location-sheets'
  | 'storyboard:motion'
  | 'storyboard:music'
  | 'storyboard:shot-images'
  | 'variant-upscale';

/** Any model a fal estimate can be gated for. */
type GateModel = TextToImageModel | ImageToVideoModel | AudioModel;

/** Which model and operation a gate is standing in for. */
export type GateContext = { model: GateModel; operation: GateOperation };

/**
 * Models already reported as unpriced in this isolate — gates run inside
 * per-shot loops, so without dedup one unpriced model logs once per shot.
 */
const reportedUnpriced = new Set<string>();

/**
 * Resolve an estimate for the credit gate: the honest number when one exists,
 * otherwise the conservative floor per call. Display paths should NOT use
 * this — show nothing for null. The log dedupes per model+operation; the
 * PostHog event fires every time so the floor's frequency stays countable.
 */
export function gateEstimate(
  estimate: Microdollars | null,
  context: GateContext,
  numCalls: number = 1
): Microdollars {
  if (estimate !== null) return estimate;

  const floored = multiplyMicros(UNKNOWN_ESTIMATE_FLOOR, numCalls);
  reportFlooredEstimate({
    model: context.model,
    operation: context.operation,
    numCalls,
    floorMicros: Number(floored),
  });
  const key = `${context.model}:${context.operation}`;
  if (!reportedUnpriced.has(key)) {
    reportedUnpriced.add(key);
    logger.error(
      `No pricing signal for ${context.model} — gating ${context.operation} on the unknown-estimate floor`,
      {
        model: context.model,
        operation: context.operation,
        numCalls,
        floorMicros: Number(floored),
      }
    );
  }
  return floored;
}

/**
 * Estimate provider cost of generating images. Rough pre-flight
 * gate only — the exact charge comes from fal's reported units post-generation.
 */
export function estimateImageCost(
  model: TextToImageModel,
  aspectRatio: AspectRatio,
  numImages: number,
  opts: { pricing: FalPricingMap; resolution?: string }
): Microdollars | null {
  const { width, height } = aspectRatioToDimensions(aspectRatio);

  return estimateFalCost(
    IMAGE_MODELS[model].id,
    {
      numImages,
      widthPx: width,
      heightPx: height,
      resolution: opts.resolution,
    },
    opts.pricing
  );
}

/**
 * Estimate provider cost of generating video.
 */
export function estimateVideoCost(
  model: ImageToVideoModel,
  durationSeconds: number,
  opts: { pricing: FalPricingMap; resolution?: string }
): Microdollars | null {
  return estimateFalCost(
    IMAGE_TO_VIDEO_MODELS[model].id,
    {
      durationSeconds,
      resolution: opts.resolution,
    },
    opts.pricing
  );
}

/**
 * Estimate provider cost of generating one music track.
 */
export function estimateAudioCost(
  model: AudioModel,
  durationSeconds: number,
  opts: { pricing: FalPricingMap }
): Microdollars | null {
  return estimateFalCost(
    AUDIO_MODELS[model].id,
    { durationSeconds },
    opts.pricing
  );
}

/**
 * Rough estimate of LLM cost per call for pre-flight credit checks.
 * Based on average token usage for script analysis calls.
 * Only used for client-side gate affordability checks, not actual deduction.
 */
const AVERAGE_LLM_COST_PER_CALL_MICROS = micros(20_000); // $0.02

export function estimateLLMCost(numCalls: number = 1): Microdollars {
  return multiplyMicros(AVERAGE_LLM_COST_PER_CALL_MICROS, numCalls);
}

/** Average scene count for a typical script (used when we can't know in advance) */
const DEFAULT_ESTIMATED_SCENE_COUNT = 8;

/**
 * Estimate the total cost of a storyboard workflow.
 * Includes: LLM analysis, character/location sheet images, per-shot images,
 * and optionally per-shot motion generation.
 *
 * Gate-only: components with no honest estimate contribute the conservative
 * `UNKNOWN_ESTIMATE_FLOOR` per call rather than making the total null.
 */
export function estimateStoryboardCost(opts: {
  imageModel: TextToImageModel;
  /** Number of image models selected (multiplies per-shot image cost) */
  imageModelCount?: number;
  aspectRatio: AspectRatio;
  estimatedSceneCount?: number;
  autoGenerateMotion?: boolean;
  /**
   * Video models for per-shot motion (#545). Each is priced from its own
   * parameters — a uniform multiplier would mis-estimate a mixed selection.
   */
  videoModels?: ImageToVideoModel[];
  videoDurationSeconds?: number;
  autoGenerateMusic?: boolean;
  /**
   * Audio models for the per-sequence music track (#546). Each is priced from
   * its own parameters (ElevenLabs per-minute vs ACE-Step per-second).
   */
  audioModels?: AudioModel[];
  /** Total sequence duration in seconds (one music track spans the sequence) */
  audioDurationSeconds?: number;
  /** Live pricing map from `getEffectiveFalPricing()`. */
  pricing: FalPricingMap;
}): Microdollars {
  const sceneCount = opts.estimatedSceneCount ?? DEFAULT_ESTIMATED_SCENE_COUNT;
  const imageModelCount = opts.imageModelCount ?? 1;
  const { pricing } = opts;

  // LLM calls: script analysis + character bible + location bible (~3 calls)
  const llmCost = estimateLLMCost(3);

  // Character sheets (~3 characters on average, landscape_16_9)
  const characterSheetCost = gateEstimate(
    estimateImageCost(opts.imageModel, '16:9', 3, { pricing }),
    { model: opts.imageModel, operation: 'storyboard:character-sheets' },
    3
  );

  // Location sheets (~3 locations on average, landscape_16_9)
  const locationSheetCost = gateEstimate(
    estimateImageCost(opts.imageModel, '16:9', 3, { pricing }),
    { model: opts.imageModel, operation: 'storyboard:location-sheets' },
    3
  );

  // Per-shot images (multiplied by number of selected image models)
  const shotCost = multiplyMicros(
    gateEstimate(
      estimateImageCost(opts.imageModel, opts.aspectRatio, sceneCount, {
        pricing,
      }),
      { model: opts.imageModel, operation: 'storyboard:shot-images' },
      sceneCount
    ),
    imageModelCount
  );

  let totalCost = addMicros(
    addMicros(addMicros(llmCost, characterSheetCost), locationSheetCost),
    shotCost
  );

  // Optional motion generation for all shots. Each selected video model
  // produces its own video per shot, so sum each model's own per-shot cost
  // (priced from its parameters) rather than scaling one model's rate by a
  // count — a mixed selection has genuinely different per-model costs.
  if (opts.autoGenerateMotion && opts.videoModels?.length) {
    const duration = opts.videoDurationSeconds ?? 5;
    for (const model of opts.videoModels) {
      const perShotMotion = gateEstimate(
        estimateVideoCost(model, duration, { pricing }),
        { model, operation: 'storyboard:motion' }
      );
      totalCost = addMicros(
        totalCost,
        multiplyMicros(perShotMotion, sceneCount)
      );
    }
  }

  // Optional music generation — one track per sequence per audio model. Sum
  // each selected model's own cost (priced from its parameters) rather than
  // scaling the primary's rate by a count — a mixed selection has genuinely
  // different per-model costs (mirrors the per-model video costing above).
  if (opts.autoGenerateMusic && opts.audioModels?.length) {
    const audioDuration = opts.audioDurationSeconds ?? sceneCount * 5;
    for (const model of opts.audioModels) {
      totalCost = addMicros(
        totalCost,
        gateEstimate(estimateAudioCost(model, audioDuration, { pricing }), {
          model,
          operation: 'storyboard:music',
        })
      );
    }
  }

  return totalCost;
}
