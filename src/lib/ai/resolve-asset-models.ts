/**
 * Per-asset model resolution (#1066).
 *
 * Model identity lives on the row that recorded the generation, not on a
 * narrative unit: a scene doesn't have a model, the asset that was rendered
 * does. The selected version IS that record — `frame_variants.model` for the
 * version `frames.selectedImageVersionId` points at, `video_variants.model` for
 * the one `render_segments.selectedVideoVersionId` points at.
 *
 * Precedence, for both generate and display:
 *
 *   explicit per-request model → selected version's model → sequence → default
 *
 * A tier that is set but no longer a valid model id (e.g. a model retired after
 * the version was written) falls through to the NEXT tier rather than straight
 * to the app default — otherwise the user's sequence choice is silently skipped.
 *
 * Do NOT resolve from the `frames.imageModel` / `shots.videoModel` mirrors: a
 * preview render stamps `PREVIEW_IMAGE_MODEL` (flux_2_turbo) onto the frame
 * mirror, which is a valid `TextToImageModel`, so nothing would reject it and a
 * full-quality regenerate would silently run on the turbo edit model.
 */

import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  isValidImageToVideoModel,
  isValidTextToImageModel,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/lib/ai/models';

/**
 * The candidate models, most specific first. Every field is optional so a
 * caller only supplies the tiers it knows about (the batch paths have no
 * per-request model; a first-ever generation has no selected version).
 */
export type AssetModelSources = {
  /** Explicit per-request model — a one-off generation in a chosen model. */
  explicit?: string | null;
  /** `model` of the version the frame / render segment currently points at. */
  selectedVersionModel?: string | null;
  /** The sequence-level default (`sequences.imageModel` / `.videoModel`). */
  sequenceModel?: string | null;
};

/** First candidate that is a currently-valid model id, else the app default. */
function firstValid<T extends string>(
  candidates: ReadonlyArray<string | null | undefined>,
  isValid: (value: unknown) => value is T,
  fallback: T
): T {
  return candidates.find(isValid) ?? fallback;
}

/** Resolve the image model a still generates (or displays) with. */
export function resolveImageModel(
  sources: AssetModelSources
): TextToImageModel {
  return firstValid(
    [sources.explicit, sources.selectedVersionModel, sources.sequenceModel],
    isValidTextToImageModel,
    DEFAULT_IMAGE_MODEL
  );
}

/** Resolve the video model a clip generates (or displays) with. */
export function resolveVideoModel(
  sources: AssetModelSources
): ImageToVideoModel {
  return firstValid(
    [sources.explicit, sources.selectedVersionModel, sources.sequenceModel],
    isValidImageToVideoModel,
    DEFAULT_VIDEO_MODEL
  );
}
