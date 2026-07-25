/**
 * Batch motion cost + model resolution (#909, re-based on per-asset models in
 * #1066).
 *
 * Pulled out of `batchGenerateMotionFn` so the billing-critical per-shot
 * summation is unit-testable without a server-fn harness. Model identity lives
 * on the version that rendered the clip: an explicit batch model overrides
 * everything, else each shot's selected `video_variants` version drives it,
 * falling back to the sequence default. Shots may render with differently-priced
 * models, so the batch cost is a sum of per-shot costs — it can't collapse to
 * `cost × count`.
 */

import type { ImageToVideoModel } from '@/lib/ai/models';
import { resolveVideoModel } from '@/lib/ai/resolve-asset-models';
import { estimateVideoCost } from '@/lib/billing/cost-estimation';
import { addMicros, ZERO_MICROS, type Microdollars } from '@/lib/billing/money';
import { snapDuration } from '@/lib/motion/motion-generation';

type BatchShot = { id: string };
type SequenceModelFields = { videoModel?: string | null };
/** `shotId → video_variants.model` of the shot's selected version (#1066). */
type SelectedModelByShot = ReadonlyMap<string, string>;

/** Resolve the video model a single batch shot renders with. */
export function resolveBatchShotVideoModel(
  shot: BatchShot,
  selectedModelByShot: SelectedModelByShot,
  sequence: SequenceModelFields,
  explicitModel?: string | null
): ImageToVideoModel {
  return resolveVideoModel({
    explicit: explicitModel,
    selectedVersionModel: selectedModelByShot.get(shot.id),
    sequenceModel: sequence.videoModel,
  });
}

/**
 * Sum the estimated video cost for a batch of shots, pricing each shot with the
 * model it resolves to. Duration is snapped per resolved model so the pre-flight
 * estimate matches what the workflow ultimately bills.
 */
export function estimateBatchMotionCost(
  shots: BatchShot[],
  selectedModelByShot: SelectedModelByShot,
  sequence: SequenceModelFields,
  opts: { explicitModel?: string | null; duration?: number } = {}
): Microdollars {
  return shots.reduce((sum, shot) => {
    const model = resolveBatchShotVideoModel(
      shot,
      selectedModelByShot,
      sequence,
      opts.explicitModel
    );
    return addMicros(
      sum,
      estimateVideoCost(model, snapDuration(opts.duration, model))
    );
  }, ZERO_MICROS);
}
