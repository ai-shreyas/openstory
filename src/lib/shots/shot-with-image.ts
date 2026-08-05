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
 *
 * The VIDEO surface works the same way as of #1067 phase 2d: `videoUrl` /
 * `videoPath` / `videoGeneratedAt` / `videoInputHash` / `motionModel` were
 * columns on `shots` mirroring the selected render; they are now projected from
 * the `video_variants` row `render_segments.selectedVideoVersionId` points at
 * (a shot reaches its segment via `shots.renderSegmentId`). The projected names
 * are unchanged, so the client and realtime cache contract is untouched.
 *
 * `videoStatus` / `videoError` / `videoWorkflowRunId` deliberately REMAIN real
 * `shots` columns and are NOT projected: `videoVariants.select` refuses any
 * version that is not `completed`, so the selection pointer structurally cannot
 * carry in-flight or failed state, and `persistMotionFailure` records a failure
 * on the shot only for a PRIMARY render (`!variantOnly`) — a distinction stored
 * nowhere on the variant row. Same reasoning that kept `frames.imageStatus` /
 * `imageError` / `imageWorkflowRunId`.
 */

import type { AssemblableMotionPrompt } from '@/lib/ai/scene-analysis.schema';
import type { Frame, FrameVariant, Shot, VideoVariant } from '@/lib/db/schema';

export type ShotGridSheet = {
  url: string | null;
  // Sourced from a `frame_variants` row, whose status union is wider than the
  // frame's (adds 'cancelled', #1085).
  status: Frame['imageStatus'] | FrameVariant['status'];
};

/**
 * The version rows a shot's surface is projected from. An object (not
 * positional args) so adding a source can't silently re-bind an existing one,
 * and so every read path names what it resolved.
 *
 * `selectedImage` and `selectedVideo` are REQUIRED (not optional) so a new read
 * path can't silently project a null surface onto a shot that has one.
 */
export type ShotProjectionSources = {
  /** The anchor frame's selected `frame_variants` row. */
  selectedImage: FrameVariant | null;
  /**
   * The `video_variants` row the shot's segment points at
   * (`render_segments.selectedVideoVersionId`), resolved via
   * `videoVariants.getSelectedByShotIds` / `getSelectedByShot`.
   */
  selectedVideo: VideoVariant | null;
  gridSheet?: ShotGridSheet | null;
  motionPromptData?: AssemblableMotionPrompt | null;
};

export type ShotWithImage = Shot & {
  /** Video surface — from the segment's selected version, not a shot column. */
  videoUrl: VideoVariant['url'];
  videoPath: VideoVariant['storagePath'];
  videoGeneratedAt: VideoVariant['generatedAt'];
  videoInputHash: VideoVariant['inputHash'];
  /** Null when never rendered — absent means absent, not a default. */
  motionModel: VideoVariant['model'] | null;
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
export function projectShotMissingFrame(
  shot: Shot,
  selectedVideo: VideoVariant | null
): ShotWithImage {
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
  // A frameless shot still has a video surface: video hangs off the shot's
  // render segment, not off the frame.
  return projectShotWithImage(shot, frame, {
    selectedImage: null,
    selectedVideo,
  });
}

export function projectShotWithImage(
  shot: Shot,
  frame: Frame,
  sources: ShotProjectionSources
): ShotWithImage {
  const { selectedImage, selectedVideo, gridSheet, motionPromptData } = sources;
  return {
    ...shot,
    videoUrl: selectedVideo?.url ?? null,
    videoPath: selectedVideo?.storagePath ?? null,
    videoGeneratedAt: selectedVideo?.generatedAt ?? null,
    videoInputHash: selectedVideo?.inputHash ?? null,
    motionModel: selectedVideo?.model ?? null,
    thumbnailUrl: selectedImage?.url ?? null,
    previewThumbnailUrl: frame.previewImageUrl,
    thumbnailPath: selectedImage?.storagePath ?? null,
    thumbnailStatus: frame.imageStatus,
    thumbnailWorkflowRunId: frame.imageWorkflowRunId,
    thumbnailError: frame.imageError,
    imageModel: selectedImage?.model ?? null,
    imagePrompt: frame.imagePrompt,
    thumbnailInputHash: selectedImage?.inputHash ?? null,
    visualPromptInputHash: frame.visualPromptInputHash,
    variantImageUrl: gridSheet?.url ?? null,
    variantImageStatus: gridSheet?.status ?? null,
    frame,
    motionPromptData: motionPromptData ?? null,
  };
}
