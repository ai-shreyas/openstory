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
 * `variantImageUrl` / `variantImageStatus` are the 3×3 grid sheet, now a
 * `kind:'framing'` `frame_variants` version rather than a shots column.
 */

import type { AssemblableMotionPrompt } from '@/lib/ai/scene-analysis.schema';
import type { Frame, Shot } from '@/lib/db/schema';

export type ShotGridSheet = {
  url: string | null;
  status: Frame['imageStatus'];
};

export type ShotWithImage = Shot & {
  thumbnailUrl: Frame['imageUrl'];
  previewThumbnailUrl: Frame['previewImageUrl'];
  thumbnailPath: Frame['imagePath'];
  thumbnailStatus: Frame['imageStatus'];
  thumbnailWorkflowRunId: Frame['imageWorkflowRunId'];
  thumbnailGeneratedAt: Frame['imageGeneratedAt'];
  thumbnailError: Frame['imageError'];
  imageModel: Frame['imageModel'];
  imagePrompt: Frame['imagePrompt'];
  thumbnailInputHash: Frame['imageInputHash'];
  visualPromptInputHash: Frame['visualPromptInputHash'];
  variantImageUrl: string | null;
  variantImageStatus: Frame['imageStatus'];
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
    imageUrl: null,
    previewImageUrl: null,
    imagePath: null,
    imageStatus: null,
    imageWorkflowRunId: null,
    imageGeneratedAt: null,
    imageError: null,
    // Must match the `frames.imageModel` SQL column default (a deliberately
    // frozen literal — see schema/frames.ts on why it is NOT the mutable
    // DEFAULT_IMAGE_MODEL constant). Irrelevant in practice: a frameless shot
    // has no image, so this never-relied-on fallback is just shape-filling.
    imageModel: 'nano_banana_2',
    imagePrompt: null,
    selectedImageVersionId: null,
    selectedImagePromptVersionId: null,
    pendingPromoteVersionId: null,
    imageInputHash: null,
    visualPromptInputHash: null,
    createdAt: shot.createdAt,
    updatedAt: shot.updatedAt,
  };
  return projectShotWithImage(shot, frame);
}

export function projectShotWithImage(
  shot: Shot,
  frame: Frame,
  gridSheet?: ShotGridSheet | null,
  motionPromptData?: AssemblableMotionPrompt | null
): ShotWithImage {
  return {
    ...shot,
    thumbnailUrl: frame.imageUrl,
    previewThumbnailUrl: frame.previewImageUrl,
    thumbnailPath: frame.imagePath,
    thumbnailStatus: frame.imageStatus,
    thumbnailWorkflowRunId: frame.imageWorkflowRunId,
    thumbnailGeneratedAt: frame.imageGeneratedAt,
    thumbnailError: frame.imageError,
    imageModel: frame.imageModel,
    imagePrompt: frame.imagePrompt,
    thumbnailInputHash: frame.imageInputHash,
    visualPromptInputHash: frame.visualPromptInputHash,
    variantImageUrl: gridSheet?.url ?? null,
    variantImageStatus: gridSheet?.status ?? null,
    frame,
    motionPromptData: motionPromptData ?? null,
  };
}
