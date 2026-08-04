/**
 * ShotWithImage — the API/client shape of a shot with its image surface.
 *
 * The still IMAGE columns moved off `shots` onto the anchor `frame` in #989
 * (a shot is the VIDEO unit, a frame is the IMAGE unit). To keep the client and
 * realtime contract stable — so the UI keeps its current structure (one frame
 * per shot → render the anchor) — server read paths project the anchor frame's
 * `image*` fields back under the legacy `thumbnail*` / `image*` names the UI and
 * cache already read. The raw `frame` is also exposed for callers that want the
 * real shape (version pickers, etc.).
 *
 * `variantImageUrl` / `variantImageStatus` are the 3×3 grid sheet, a
 * `kind:'framing'` `frame_variants` version.
 *
 * The still's url/path/model/hash come from the SELECTED `frame_variants` row;
 * this file is the only place that knows that.
 */

import type { AssemblableMotionPrompt } from '@/lib/ai/scene-analysis.schema';
import type { Frame, FrameVariant, Shot } from '@/lib/db/schema';

export type ShotGridSheet = {
  url: string | null;
  // Sourced from a `frame_variants` row, whose status union is wider than the
  // frame's (adds 'cancelled', #1085).
  status: Frame['imageStatus'] | FrameVariant['status'];
};

export type ShotWithImage = Shot & {
  thumbnailUrl: FrameVariant['url'];
  previewThumbnailUrl: Frame['previewImageUrl'];
  thumbnailPath: FrameVariant['storagePath'];
  thumbnailStatus: Frame['imageStatus'];
  thumbnailWorkflowRunId: Frame['imageWorkflowRunId'];
  thumbnailError: Frame['imageError'];
  /** Null when never generated — absent means absent, not a default. */
  imageModel: FrameVariant['model'] | null;
  imagePrompt: Frame['imagePrompt'];
  thumbnailInputHash: FrameVariant['inputHash'];
  visualPromptInputHash: Frame['visualPromptInputHash'];
  variantImageUrl: string | null;
  variantImageStatus: ShotGridSheet['status'] | null;
  /** The anchor frame, verbatim — for version/variant-aware callers. */
  frame: Frame;
  /**
   * The shot's selected motion prompt (reconstructed from its
   * `shot_prompt_versions` row) — the assemblable fields the client motion
   * preview needs after `metadata.prompts.motion` was removed (#713). Null when
   * the shot has no motion prompt version yet.
   */
  motionPromptData: AssemblableMotionPrompt | null;
};

/**
 * Project a shot whose anchor frame row is absent. Every shot should own one
 * (migration backfill + `shots.ensureAnchorFrames`), but a batch read that
 * left-joins must not DROP a frameless shot — that would make it vanish from
 * the list. Returns the shot with a null image surface (and a synthetic anchor
 * frame so the shape is uniform).
 */
export function projectShotMissingFrame(shot: Shot): ShotWithImage {
  const frame: Frame = {
    // Synthetic in-memory placeholder ONLY — never persisted and never used for
    // a frame_variants lookup. `id: shot.id` deliberately resurrects the
    // migration-only frame.id == shot.id equality the rest of the codebase
    // forbids at runtime (frames.ts `getAnchorByShot`); it is safe solely
    // because a frameless shot has no variants to resolve by frame id. Do NOT
    // pass this id to any `frame_variants`/`frame_prompt_versions` query.
    id: shot.id,
    shotId: shot.id,
    sequenceId: shot.sequenceId,
    orderIndex: 0,
    role: 'first',
    source: 'generated',
    previewImageUrl: null,
    imageStatus: null,
    imageWorkflowRunId: null,
    imageError: null,
    imagePrompt: null,
    selectedImageVersionId: null,
    selectedImagePromptVersionId: null,
    pendingPromoteVersionId: null,
    visualPromptInputHash: null,
    createdAt: shot.createdAt,
    updatedAt: shot.updatedAt,
  };
  return projectShotWithImage(shot, frame, null);
}

/**
 * `selectedVersion` is required (not optional) so a new read path can't
 * silently project a null image surface onto a frame that has one.
 */
export function projectShotWithImage(
  shot: Shot,
  frame: Frame,
  selectedVersion: FrameVariant | null,
  gridSheet?: ShotGridSheet | null,
  motionPromptData?: AssemblableMotionPrompt | null
): ShotWithImage {
  return {
    ...shot,
    thumbnailUrl: selectedVersion?.url ?? null,
    previewThumbnailUrl: frame.previewImageUrl,
    thumbnailPath: selectedVersion?.storagePath ?? null,
    thumbnailStatus: frame.imageStatus,
    thumbnailWorkflowRunId: frame.imageWorkflowRunId,
    thumbnailError: frame.imageError,
    imageModel: selectedVersion?.model ?? null,
    imagePrompt: frame.imagePrompt,
    thumbnailInputHash: selectedVersion?.inputHash ?? null,
    visualPromptInputHash: frame.visualPromptInputHash,
    variantImageUrl: gridSheet?.url ?? null,
    variantImageStatus: gridSheet?.status ?? null,
    frame,
    motionPromptData: motionPromptData ?? null,
  };
}
