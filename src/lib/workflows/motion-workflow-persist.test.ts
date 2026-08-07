/**
 * Behavioural tests for the motion-workflow persist helpers (#545, re-routed to
 * `video_variants` in #990).
 *
 * `MotionWorkflow` opens an append-only `video_variants` version in
 * `set-generating-status`; these helpers finalize it:
 *
 *   - completed: flip the version to `completed`, log `video.rendered`, and (for
 *     a primary render) repoint the shot's selection via `videoVariants.select`
 *     (which repoints the render segment's selection pointer). A `variantOnly`
 *     render skips the select. Shot-deleted mid-flight skips the select too.
 *   - failed: mark the version failed by workflow run id — the shot's video
 *     status derives from that row since #1067 phase 2d, so nothing is written
 *     to `shots`.
 */

import { describe, expect, it } from 'vitest';
import type { NewShot, NewVideoVariant } from '@/lib/db/schema';
import type { RecordEventInput } from '@/lib/db/scoped/sequence-events';
import {
  type MotionVideoProgressPayload,
  persistMotionCompletion,
  persistMotionFailure,
  type PersistMotionScopedDb,
} from './motion-workflow-persist';

// `buildMotionGeneratingShotWrite` is gone: the in-flight state is the appended
// `video_variants` row, covered by `persistMotionFailure` + shot-view.

const upload = {
  url: 'https://r2/seq/shot-veo.mp4',
  path: 'team/seq/shot.mp4',
};
const NOW = new Date('2026-06-02T00:00:00Z');

type CallName =
  | 'videoVariants.update'
  | 'videoVariants.select'
  | 'videoVariants.markFailedByWorkflowRun'
  | 'videoVariants.appendVersion'
  | 'videoVariants.getById'
  | 'renderSegments.getById'
  | 'renderSegments.clearPending'
  | 'sequenceEvents.record'
  | 'shots.getById'
  | 'shots.update';

function buildScopedDbSpy(
  opts: {
    shotMissing?: boolean;
    /** When set, completion promotes only if videoVersionId matches. */
    pendingPromoteVersionId?: string | null;
    segmentId?: string;
    /**
     * Rows `markFailedByWorkflowRun` matches. 0 models a run that died before
     * `set-generating-status` appended its version.
     */
    markFailedRows?: number;
  } = {}
): {
  scopedDb: PersistMotionScopedDb;
  versionUpdates: Array<{ id: string; data: Partial<NewVideoVariant> }>;
  selects: Array<{ shotId: string; versionId: string; actorId: string | null }>;
  markFailed: Array<{ runId: string; error: string }>;
  appended: NewVideoVariant[];
  events: RecordEventInput[];
  shotUpdates: Array<{ shotId: string; data: Partial<NewShot> }>;
  callOrder: CallName[];
  pendingClears: string[];
} {
  const versionUpdates: Array<{ id: string; data: Partial<NewVideoVariant> }> =
    [];
  const selects: Array<{
    shotId: string;
    versionId: string;
    actorId: string | null;
  }> = [];
  const markFailed: Array<{ runId: string; error: string }> = [];
  const appended: NewVideoVariant[] = [];
  const events: RecordEventInput[] = [];
  const shotUpdates: Array<{ shotId: string; data: Partial<NewShot> }> = [];
  const callOrder: CallName[] = [];
  const pendingClears: string[] = [];
  const segmentId = opts.segmentId ?? 'seg-1';
  // Default: claim matches completionArgs.videoVersionId so primary still promotes.
  let pending =
    opts.pendingPromoteVersionId === undefined
      ? 'vv1'
      : opts.pendingPromoteVersionId;

  const scopedDb: PersistMotionScopedDb = {
    shots: {
      getById: async (id) => {
        callOrder.push('shots.getById');
        return opts.shotMissing
          ? null
          : { id, sequenceId: 'seq1', renderSegmentId: segmentId };
      },
      update: async (shotId, data) => {
        callOrder.push('shots.update');
        shotUpdates.push({ shotId, data });
        return { id: shotId };
      },
    },
    videoVariants: {
      update: async (versionId, data) => {
        callOrder.push('videoVariants.update');
        versionUpdates.push({ id: versionId, data });
        return { id: versionId };
      },
      getById: async (versionId) => {
        callOrder.push('videoVariants.getById');
        return { id: versionId, workflowRunId: 'run-1' };
      },
      select: async (shotId, versionId, selectOpts) => {
        callOrder.push('videoVariants.select');
        selects.push({ shotId, versionId, actorId: selectOpts.actorId });
        return { id: versionId };
      },
      markFailedByWorkflowRun: async (runId, error) => {
        callOrder.push('videoVariants.markFailedByWorkflowRun');
        markFailed.push({ runId, error });
        return opts.markFailedRows ?? 1;
      },
      appendVersion: async (data) => {
        callOrder.push('videoVariants.appendVersion');
        appended.push(data);
        return { id: 'vv-appended' };
      },
    },
    renderSegments: {
      getById: async (id) => {
        callOrder.push('renderSegments.getById');
        return {
          id,
          pendingPromoteVersionId: pending,
        };
      },
      setPendingPromoteVersionId: async (_segmentId, versionId) => {
        pending = versionId;
      },
      clearPendingPromoteVersionIdIf: async (_segmentId, versionId) => {
        callOrder.push('renderSegments.clearPending');
        pendingClears.push(versionId);
        if (pending === versionId) pending = null;
      },
    },
    sequenceEvents: {
      record: async (input) => {
        callOrder.push('sequenceEvents.record');
        events.push(input);
        return { id: 'evt' };
      },
    },
  };

  return {
    scopedDb,
    versionUpdates,
    selects,
    markFailed,
    appended,
    events,
    shotUpdates,
    callOrder,
    pendingClears,
  };
}

const completionArgs = {
  shotId: 'f1',
  sequenceId: 'seq1',
  sceneId: 'scene1',
  videoVersionId: 'vv1',
  model: 'veo3',
  upload,
};

describe('persistMotionCompletion', () => {
  it('primary: finalizes the version, logs video.rendered, repoints the shot, emits completed', async () => {
    const spy = buildScopedDbSpy();
    const emits: Array<{ event: string; payload: MotionVideoProgressPayload }> =
      [];

    const outcome = await persistMotionCompletion({
      scopedDb: spy.scopedDb,
      ...completionArgs,
      actorId: 'user1',
      emit: async (event, payload) => {
        emits.push({ event, payload });
      },
      now: () => NOW,
    });

    expect(outcome).toEqual({ status: 'completed', videoUrl: upload.url });
    expect(spy.callOrder).toEqual([
      'videoVariants.update',
      'sequenceEvents.record',
      'shots.getById',
      'renderSegments.getById',
      'videoVariants.select',
    ]);

    const [versionUpdate] = spy.versionUpdates;
    if (!versionUpdate) throw new Error('expected videoVariants.update');
    expect(versionUpdate.id).toBe('vv1');
    expect(versionUpdate.data).toEqual({
      url: upload.url,
      storagePath: upload.path,
      status: 'completed',
      generatedAt: NOW,
      error: null,
    });

    expect(spy.events[0]?.kind).toBe('video.rendered');
    expect(spy.selects).toEqual([
      { shotId: 'f1', versionId: 'vv1', actorId: 'user1' },
    ]);
    expect(emits).toEqual([
      {
        event: 'generation.video:progress',
        payload: {
          shotId: 'f1',
          status: 'completed',
          videoUrl: upload.url,
          model: 'veo3',
        },
      },
    ]);
  });

  it('variant-only: finalizes the version + logs, but never repoints the shot', async () => {
    const spy = buildScopedDbSpy();
    const emits: MotionVideoProgressPayload[] = [];

    const outcome = await persistMotionCompletion({
      scopedDb: spy.scopedDb,
      ...completionArgs,
      actorId: 'user1',
      variantOnly: true,
      emit: async (_event, payload) => {
        emits.push(payload);
      },
      now: () => NOW,
    });

    expect(outcome).toEqual({ status: 'completed', videoUrl: upload.url });
    expect(spy.callOrder).toEqual([
      'videoVariants.update',
      'sequenceEvents.record',
    ]);
    expect(spy.selects).toEqual([]);
    expect(emits).toEqual([
      {
        shotId: 'f1',
        status: 'completed',
        videoUrl: upload.url,
        model: 'veo3',
        variantOnly: true,
      },
    ]);
  });

  it('shot deleted mid-flight: finalizes the version but skips the repoint + emit', async () => {
    const spy = buildScopedDbSpy({ shotMissing: true });
    const emits: MotionVideoProgressPayload[] = [];

    const outcome = await persistMotionCompletion({
      scopedDb: spy.scopedDb,
      ...completionArgs,
      actorId: null,
      emit: async (_event, payload) => {
        emits.push(payload);
      },
      now: () => NOW,
    });

    expect(outcome).toEqual({ status: 'shot-deleted' });
    expect(spy.callOrder).toEqual([
      'videoVariants.update',
      'sequenceEvents.record',
      'shots.getById',
    ]);
    expect(spy.selects).toEqual([]);
    expect(emits).toEqual([]);
  });

  it('does not promote when pending claim moved to another version (#1070)', async () => {
    const spy = buildScopedDbSpy({ pendingPromoteVersionId: 'vv-other' });
    const emits: MotionVideoProgressPayload[] = [];

    const outcome = await persistMotionCompletion({
      scopedDb: spy.scopedDb,
      ...completionArgs,
      actorId: 'user1',
      emit: async (_event, payload) => {
        emits.push(payload);
      },
      now: () => NOW,
    });

    expect(outcome).toEqual({ status: 'completed', videoUrl: upload.url });
    expect(spy.selects).toEqual([]);
    expect(spy.pendingClears).toEqual(['vv1']);
    expect(emits).toEqual([
      {
        shotId: 'f1',
        status: 'completed',
        videoUrl: upload.url,
        model: 'veo3',
        variantOnly: true,
      },
    ]);
  });
});

describe('persistMotionFailure', () => {
  it('primary: marks the version failed (no shot write) and emits with the reason', async () => {
    const spy = buildScopedDbSpy();
    const emits: Array<{ event: string; payload: MotionVideoProgressPayload }> =
      [];

    await persistMotionFailure({
      scopedDb: spy.scopedDb,
      shotId: 'f1',
      model: 'veo3',
      error: 'fal 500',
      workflowRunId: 'run-9',
      emit: async (event, payload) => {
        emits.push({ event, payload });
      },
    });

    expect(spy.callOrder).toEqual([
      'shots.getById',
      'renderSegments.getById',
      'videoVariants.getById',
      // pending row's run id is 'run-1' in the spy, not 'run-9' — no clear
      'videoVariants.markFailedByWorkflowRun',
    ]);
    // The failure lives on the version row only — the shot has no video columns
    // to flip since #1067 phase 2d, so `videoStatus`/`videoError` derive from it.
    expect(spy.shotUpdates).toEqual([]);
    expect(spy.markFailed).toEqual([{ runId: 'run-9', error: 'fal 500' }]);
    expect(emits).toEqual([
      {
        event: 'generation.video:progress',
        payload: {
          shotId: 'f1',
          status: 'failed',
          model: 'veo3',
          error: 'fal 500',
        },
      },
    ]);
    // Nothing to append — the in-flight row existed and was marked.
    expect(spy.appended).toEqual([]);
  });

  // A run that dies before `set-generating-status` (insufficient credits, "shot
  // has no scene") has no version row to mark. Since the version row is the only
  // record of video lifecycle since #1067 phase 2d, a silent no-op would let the
  // shot revert to 'pending' on the next refetch — erasing the failure the user
  // just saw.
  it('appends a terminal failed version when the run never opened one', async () => {
    const spy = buildScopedDbSpy({ markFailedRows: 0 });

    await persistMotionFailure({
      scopedDb: spy.scopedDb,
      shotId: 'f1',
      model: 'veo3',
      error: 'Insufficient credits for motion generation',
      workflowRunId: 'run-9',
      emit: async () => {},
    });

    expect(spy.appended).toEqual([
      {
        renderSegmentId: 'seg-1',
        sequenceId: 'seq1',
        model: 'veo3',
        manifest: [],
        status: 'failed',
        error: 'Insufficient credits for motion generation',
        workflowRunId: 'run-9',
        isPrimary: true,
      },
    ]);
    expect(spy.shotUpdates).toEqual([]);
  });

  it('appends the fallback row as non-primary for a variant-only run', async () => {
    const spy = buildScopedDbSpy({ markFailedRows: 0 });

    await persistMotionFailure({
      scopedDb: spy.scopedDb,
      shotId: 'f1',
      model: 'kling',
      error: 'Insufficient credits for motion generation',
      workflowRunId: 'run-9',
      emit: async () => {},
      variantOnly: true,
    });

    // isPrimary false, so this failure never becomes the shot's video status.
    expect(spy.appended[0]?.isPrimary).toBe(false);
  });

  it('variant-only: marks the version failed without resolving the primary slot', async () => {
    const spy = buildScopedDbSpy();

    await persistMotionFailure({
      scopedDb: spy.scopedDb,
      shotId: 'f1',
      model: 'veo3',
      error: 'fal 500',
      workflowRunId: 'run-9',
      variantOnly: true,
      emit: async () => {},
    });

    expect(spy.shotUpdates).toEqual([]);
    // The shot is read (it carries the segment id the fallback append needs),
    // but the primary slot is never resolved: no renderSegments.getById, no
    // pending-promote clear.
    expect(spy.callOrder).toEqual([
      'shots.getById',
      'videoVariants.markFailedByWorkflowRun',
    ]);
    expect(spy.markFailed).toEqual([{ runId: 'run-9', error: 'fal 500' }]);
    expect(spy.appended).toEqual([]);
  });
});
