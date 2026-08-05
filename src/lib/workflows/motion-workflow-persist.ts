/**
 * Persist orchestration for `MotionWorkflow` (#545, re-routed to `video_variants`
 * in #990).
 *
 * Motion generation now writes each render as an append-only `video_variants`
 * **version** (keyed by `(renderSegmentId, model)`), replacing the retired
 * `shot_variants` video slice. `set-generating-status` appends the in-flight
 * version (built in the workflow, which has the scene/manifest context); these
 * helpers finalize it:
 *
 * - completion: flip the version to `completed`, then (for a primary, non
 *   `variantOnly` render) repoint the shot's selection via
 *   `videoVariants.select` — which mirrors `shots.video*` + repoints the render
 *   segment's `selectedVideoVersionId` pointer + logs a `video.selected` event,
 *   all atomically.
 * - failure: mark the in-flight version `failed` (by workflow run id) and, for a
 *   primary render, flip the legacy `shots.video*` status so the failure banner
 *   shows on refetch.
 *
 * Pulled out of the workflow body (mirroring `image-workflow-snapshot.ts`'s
 * `persistImageResult`) so the generating → completed → failed state machine is
 * testable without bootstrapping a `WorkflowEntrypoint`.
 */

import type { NewShot, NewVideoVariant } from '@/lib/db/schema';
import type { RecordEventInput } from '@/lib/db/scoped/sequence-events';

export type MotionStorageResult = { url: string; path: string };

/**
 * Minimum scopedDb surface for the persist orchestrators. Production
 * `ScopedDb` is a structural superset and assigns cleanly; tests build literal
 * spies against this type without casting (same pattern as
 * `PersistImageScopedDb`).
 */
export type PersistMotionScopedDb = {
  shots: {
    getById: (
      id: string
    ) => Promise<{ id: string; renderSegmentId: string | null } | null>;
    update: (
      id: string,
      data: Partial<NewShot>,
      opts?: { throwOnMissing?: boolean }
    ) => Promise<{ id: string } | undefined>;
  };
  videoVariants: {
    update: (
      versionId: string,
      data: Partial<NewVideoVariant>
    ) => Promise<{ id: string }>;
    getById: (
      versionId: string
    ) => Promise<{ id: string; workflowRunId: string | null } | null>;
    select: (
      shotId: string,
      versionId: string,
      opts: { actorId: string | null }
    ) => Promise<{ id: string }>;
    markFailedByWorkflowRun: (
      workflowRunId: string,
      error: string
    ) => Promise<void>;
  };
  renderSegments: {
    getById: (segmentId: string) => Promise<{
      id: string;
      pendingPromoteVersionId: string | null;
    } | null>;
    setPendingPromoteVersionId: (
      segmentId: string,
      versionId: string | null
    ) => Promise<void>;
    clearPendingPromoteVersionIdIf: (
      segmentId: string,
      versionId: string
    ) => Promise<void>;
  };
  sequenceEvents: {
    record: (input: RecordEventInput) => Promise<{ id: string }>;
  };
};

/**
 * Payload shape for `generation.video:progress`. A subset of the realtime
 * schema (see `src/lib/realtime/index.ts`) — assignable to the channel's
 * emitter so the workflow can forward it directly.
 */
export type MotionVideoProgressPayload =
  | {
      shotId: string;
      status: 'completed';
      videoUrl: string;
      model: string;
      // Variant-only (#547): added model — cache updater must not repoint the
      // primary video.
      variantOnly?: boolean;
    }
  | {
      shotId: string;
      status: 'failed';
      model: string;
      variantOnly?: boolean;
      // Failure reason so the cache updater writes `shots.videoError` live
      // (else the FailureSummaryBanner shows "Unknown error" until refetch). (#881)
      error?: string;
    };

export type MotionEmit = (
  event: 'generation.video:progress',
  payload: MotionVideoProgressPayload
) => Promise<void>;

/**
 * The shot-owned in-flight write for `set-generating-status`. Model identity
 * lives on the `video_variants` version the workflow appends alongside this
 * (#1067 phase 2d dropped the `shots.motionModel` mirror; `resolve-asset-models`
 * already forbade reading it). What stays here is the primary render's status +
 * run id, which no selection pointer can carry — `videoVariants.select` only
 * ever points at a `completed` version.
 */
export function buildMotionGeneratingShotWrite(opts: {
  workflowRunId: string;
}): Partial<NewShot> {
  return {
    videoStatus: 'generating',
    videoWorkflowRunId: opts.workflowRunId,
  };
}

export type PersistMotionOutcome =
  | { status: 'completed'; videoUrl: string }
  | { status: 'shot-deleted' };

/**
 * Completed write. Flips the in-flight `video_variants` version to `completed`,
 * then — for a primary render — repoints the shot's selection
 * (`videoVariants.select` mirrors `shots.video*` + the render segment's
 * `selectedVideoVersionId` pointer + logs `video.selected`). A `variantOnly`
 * render (an added model, #547) only
 * finalizes its version, leaving the primary selection untouched. A
 * `video.rendered` activity event is logged either way.
 *
 * If the shot was deleted mid-flight (`getById` returns null), the version is
 * still finalized (it is scene-scoped, not shot-cascaded) but the selection
 * repoint is skipped — mirroring `persistImageResult`'s shot-deleted guard.
 *
 * `now` is injectable so tests can pin the `generatedAt` timestamp.
 */
export async function persistMotionCompletion(opts: {
  scopedDb: PersistMotionScopedDb;
  shotId: string;
  sequenceId: string;
  sceneId: string;
  videoVersionId: string;
  model: string;
  upload: MotionStorageResult;
  actorId: string | null;
  emit: MotionEmit;
  /**
   * Variant-only (#547): only finalize this render's version; never repoint the
   * shot's primary selection — adding a video model leaves the primary intact.
   */
  variantOnly?: boolean;
  now?: () => Date;
}): Promise<PersistMotionOutcome> {
  const {
    scopedDb,
    shotId,
    sequenceId,
    sceneId,
    videoVersionId,
    model,
    upload,
    actorId,
    emit,
    variantOnly,
    now = () => new Date(),
  } = opts;

  await scopedDb.videoVariants.update(videoVersionId, {
    url: upload.url,
    storagePath: upload.path,
    status: 'completed',
    generatedAt: now(),
    error: null,
  });

  await scopedDb.sequenceEvents.record({
    sequenceId,
    actorId,
    kind: 'video.rendered',
    targetType: 'shot',
    targetId: shotId,
    summary: `Rendered ${model} video`,
    data: {
      versionId: videoVersionId,
      model,
      sceneId,
      variantOnly: !!variantOnly,
    },
  });

  if (variantOnly) {
    await emit('generation.video:progress', {
      shotId,
      status: 'completed',
      videoUrl: upload.url,
      model,
      // Alternate model — the cache updater must not repoint the primary.
      variantOnly: true,
    });
    return { status: 'completed', videoUrl: upload.url };
  }

  // A primary render: promote only if this version still holds the pending
  // claim (#1070 last-kickoff + explicit select cancel).
  const shot = await scopedDb.shots.getById(shotId);
  if (!shot) return { status: 'shot-deleted' };

  const segmentId = shot.renderSegmentId;
  const segment = segmentId
    ? await scopedDb.renderSegments.getById(segmentId)
    : null;
  const shouldPromote = segment?.pendingPromoteVersionId === videoVersionId;

  if (shouldPromote) {
    await scopedDb.videoVariants.select(shotId, videoVersionId, { actorId });
    await emit('generation.video:progress', {
      shotId,
      status: 'completed',
      videoUrl: upload.url,
      model,
    });
  } else {
    // History-only completion — leave the primary selection alone. Clear a
    // stale self-claim if any (usually already cleared by a newer kickoff or
    // user select).
    if (segmentId) {
      await scopedDb.renderSegments.clearPendingPromoteVersionIdIf(
        segmentId,
        videoVersionId
      );
    }
    // Still emit completed so the variant list refreshes; primary video*
    // columns stay as they are (cache updater must not overwrite when the
    // client still has a different selected version — emit without
    // forcing primary: videoUrl is present but selection is separate).
    await emit('generation.video:progress', {
      shotId,
      status: 'completed',
      videoUrl: upload.url,
      model,
      // Not selected as primary — treat like variant-only for cache primary.
      variantOnly: true,
    });
  }

  return { status: 'completed', videoUrl: upload.url };
}

/**
 * Failure write (called from the workflow's `onFailure`). Marks the in-flight
 * `video_variants` version `failed` by workflow run id — which preserves a
 * previously-completed version's url (a re-run that fails before producing a new
 * video must not erase the last good one, since only the still-`generating` row
 * is touched). For a primary render it also flips the legacy `shots.video*`
 * status so the failure banner shows after a refetch.
 */
export async function persistMotionFailure(opts: {
  scopedDb: PersistMotionScopedDb;
  shotId: string;
  model: string;
  error: string;
  workflowRunId: string;
  emit: MotionEmit;
  /** Variant-only (#547): never touch the legacy `shots.video*` columns. */
  variantOnly?: boolean;
}): Promise<void> {
  const { scopedDb, shotId, model, error, workflowRunId, emit, variantOnly } =
    opts;

  if (!variantOnly) {
    await scopedDb.shots.update(
      shotId,
      { videoStatus: 'failed', videoError: error },
      { throwOnMissing: false }
    );
    // Drop auto-promote if this run owned it (#1070).
    const shot = await scopedDb.shots.getById(shotId);
    if (shot?.renderSegmentId) {
      const segment = await scopedDb.renderSegments.getById(
        shot.renderSegmentId
      );
      if (segment?.pendingPromoteVersionId) {
        const pending = await scopedDb.videoVariants.getById(
          segment.pendingPromoteVersionId
        );
        if (pending?.workflowRunId === workflowRunId) {
          await scopedDb.renderSegments.clearPendingPromoteVersionIdIf(
            shot.renderSegmentId,
            pending.id
          );
        }
      }
    }
  }

  await scopedDb.videoVariants.markFailedByWorkflowRun(workflowRunId, error);

  await emit('generation.video:progress', {
    shotId,
    status: 'failed',
    model,
    // Carry the reason so the cache updater writes `videoError` live (skip for
    // variant-only — the primary row isn't touched). (#881)
    ...(variantOnly ? {} : { error }),
    // A failed alternate must not flip the primary video to `failed` in cache.
    variantOnly,
  });
}
