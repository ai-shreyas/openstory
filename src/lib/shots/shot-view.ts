/**
 * ShotView — a shot with the rows a read path resolves alongside it.
 *
 * A shot owns no assets. Its still lives on the anchor `frame`'s selected
 * `frame_variants` row, its prompt on the selected `frame_prompt_versions` row,
 * and its video on the `video_variants` row the shot's render segment points
 * at. This type is the assembled read model — it exposes those rows AS
 * THEMSELVES rather than flattening them into a third set of names.
 */

import type { AssemblableMotionPrompt } from '@/lib/ai/scene-analysis.schema';
import type {
  Frame,
  FramePromptVersion,
  FrameVariant,
  Shot,
  VideoVariant,
} from '@/lib/db/schema';

export type ShotGridSheet = {
  url: string | null;
  // Sourced from a `frame_variants` row, whose status union is wider than the
  // frame's (adds 'cancelled', #1085).
  status: Frame['imageStatus'] | FrameVariant['status'];
};

/**
 * The rows a shot's view is assembled from. An object (not positional args) so
 * adding a source can't silently re-bind an existing one. Required, not
 * optional, so a new read path can't quietly assemble an empty view for a shot
 * that has one.
 */
export type ShotViewSources = {
  /** The anchor frame's selected `frame_variants` row. */
  image: FrameVariant | null;
  /** The anchor frame's selected `frame_prompt_versions` row. */
  imagePromptVersion: FramePromptVersion | null;
  /** The version `render_segments.selectedVideoVersionId` points at. */
  video: VideoVariant | null;
  /**
   * The newest non-`variantOnly` render for the shot's segment — its lifecycle
   * IS the shot's video status. Separate from `video` because only a
   * `completed` version is ever selectable, so the pointer alone can never
   * express generating/failed.
   */
  primaryVideo: VideoVariant | null;
  gridSheet?: ShotGridSheet | null;
  motionPrompt?: AssemblableMotionPrompt | null;
};

export type ShotView = Shot & {
  /** The anchor frame — owns the still's lifecycle (status/error/preview). */
  frame: Frame;
  image: FrameVariant | null;
  imagePromptVersion: FramePromptVersion | null;
  video: VideoVariant | null;
  primaryVideo: VideoVariant | null;
  /**
   * Derived, not stored: the newest primary render's lifecycle wins, so
   * re-rolling over a good video reads 'generating'. Falls back to the
   * selection for pre-#1067 rows that have no primary render behind them.
   */
  videoStatus: VideoVariant['status'] | null;
  gridSheet: ShotGridSheet | null;
  motionPrompt: AssemblableMotionPrompt | null;
};

/**
 * Assemble a shot whose anchor frame row is absent. Every shot should own one
 * (migration backfill + `shots.ensureAnchorFrames`), but a batch read that
 * left-joins must not DROP a frameless shot — that would make it vanish from
 * the list.
 */
export function shotViewMissingFrame(
  shot: Shot,
  video: Pick<ShotViewSources, 'video' | 'primaryVideo' | 'motionPrompt'>
): ShotView {
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
    selectedImageVersionId: null,
    selectedImagePromptVersionId: null,
    pendingPromoteVersionId: null,
    createdAt: shot.createdAt,
    updatedAt: shot.updatedAt,
  };
  // A frameless shot still has a video: video hangs off the segment.
  return toShotView(shot, frame, {
    image: null,
    imagePromptVersion: null,
    ...video,
  });
}

export function toShotView(
  shot: Shot,
  frame: Frame,
  sources: ShotViewSources
): ShotView {
  const { image, imagePromptVersion, video, primaryVideo } = sources;
  return {
    ...shot,
    frame,
    image,
    imagePromptVersion,
    video,
    primaryVideo,
    videoStatus: primaryVideo?.status ?? (video ? 'completed' : null),
    gridSheet: sources.gridSheet ?? null,
    motionPrompt: sources.motionPrompt ?? null,
  };
}
