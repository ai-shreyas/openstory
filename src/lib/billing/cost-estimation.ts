/**
 * Cost Estimation Utilities
 * Estimate generation costs before triggering workflows.
 * All functions return Microdollars for exact arithmetic — or null when no
 * honest estimate exists for the model (#1069; see `estimateFalCost`).
 *
 * Pass `pricing` from `getEffectiveFalPricing()` to estimate against the
 * live `model_pricing` table (observed median units, current prices); the
 * default is the baked-in static seed. Estimators stay synchronous so pure
 * callers and tests need no DB.
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
import { type Microdollars, addMicros, micros, multiplyMicros } from './money';

const logger = getLogger(['openstory', 'billing', 'cost-estimation']);

type FalPricingMap = Record<string, EffectiveFalPricing>;

/**
 * Conservative per-call floor the credit gate assumes when a model has no
 * honest estimate (null). Over-gating slightly beats under-gating — the
 * unknown compute-seconds models really cost ~$0.02–0.07/image, and the old
 * fabricated default gated Grok Imagine ~98× low (#1069). The floor stops
 * applying once the model's first observed `unitsBilled` lands in
 * `model_pricing`.
 */
const UNKNOWN_ESTIMATE_FLOOR = micros(100_000); // $0.10 per call

/** Which model and operation a gate is standing in for, so the floor is debuggable. */
export type GateContext = { model: string; operation: string };

/**
 * Models already reported as unpriced in this isolate. Gates run inside
 * per-shot loops (`estimateBatchMotionCost`, `estimateStoryboardCost`), so
 * without this one unpriced model emits an identical error per shot — 50 log
 * lines that say what one says. Isolates recycle often enough that recurrence
 * still shows up in the data.
 */
const reportedUnpriced = new Set<string>();

/**
 * Resolve an estimate for the credit gate: the honest number when one
 * exists, otherwise the conservative floor per call. Display paths should
 * NOT use this — show nothing for null instead of a made-up figure.
 *
 * Every substitution is logged. Without that, the system cannot answer "how
 * often is the gate running on a made-up number, and for which models?" —
 * which is the question #1069 existed to answer, and the floor is only
 * defensible as a temporary state we can see the end of.
 */
export function gateEstimate(
  estimate: Microdollars | null,
  context: GateContext,
  numCalls: number = 1
): Microdollars {
  if (estimate !== null) return estimate;

  const floored = multiplyMicros(UNKNOWN_ESTIMATE_FLOOR, numCalls);
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
  opts?: { resolution?: string; pricing?: FalPricingMap }
): Microdollars | null {
  const { width, height } = aspectRatioToDimensions(aspectRatio);

  return estimateFalCost(
    IMAGE_MODELS[model].id,
    {
      numImages,
      widthPx: width,
      heightPx: height,
      resolution: opts?.resolution,
    },
    opts?.pricing
  );
}

/**
 * Estimate provider cost of generating video.
 */
export function estimateVideoCost(
  model: ImageToVideoModel,
  durationSeconds: number,
  opts?: { resolution?: string; pricing?: FalPricingMap }
): Microdollars | null {
  return estimateFalCost(
    IMAGE_TO_VIDEO_MODELS[model].id,
    {
      durationSeconds,
      resolution: opts?.resolution,
    },
    opts?.pricing
  );
}

/**
 * Estimate provider cost of generating one music track.
 */
export function estimateAudioCost(
  model: AudioModel,
  durationSeconds: number,
  opts?: { pricing?: FalPricingMap }
): Microdollars | null {
  return estimateFalCost(
    AUDIO_MODELS[model].id,
    { durationSeconds },
    opts?.pricing
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
   * Video models selected for per-shot motion (#545). Each model is priced
   * individually from its own parameters — fal returns no cost, so a uniform
   * per-model multiplier would mis-estimate a mixed (e.g. cheap + audio-capable)
   * selection. First is primary; all are billed once per shot.
   */
  videoModels?: ImageToVideoModel[];
  videoDurationSeconds?: number;
  autoGenerateMusic?: boolean;
  /**
   * Audio models selected for the per-sequence music track (#546). Each model
   * is priced individually from its own parameters — audio models have
   * genuinely different rates (e.g. ElevenLabs per-minute vs ACE-Step
   * per-second), so a uniform multiplier would mis-estimate a mixed selection.
   * First is primary; one track per model spans the sequence.
   */
  audioModels?: AudioModel[];
  /** Total sequence duration in seconds (one music track spans the sequence) */
  audioDurationSeconds?: number;
  /** Live pricing map from `getEffectiveFalPricing()`; static seed if omitted */
  pricing?: FalPricingMap;
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
