/**
 * Broad reconciliation sweep for stuck generating-status rows.
 *
 * Driven by the Cloudflare Workers cron in `src/server.ts` (see
 * `wrangler.jsonc` `triggers.crons`). Scans every status-bearing table
 * directly and reconciles rows the user hasn't loaded — so idle accounts
 * get healed too. This is the only reconciler; the old on-load helper was
 * removed in #727.
 *
 * Two reconciliation shapes:
 *   A. Tables with a workflow_run_id column — query QStash, trust its truth
 *      (5min staleness threshold).
 *   B. Tables without a workflow_run_id column — blind-fail after a longer
 *      threshold (30min) because we can't verify run state.
 *
 * Each pass is capped at MAX_ROWS_PER_PASS to avoid hammering QStash if a
 * regression leaves many rows stuck.
 */

import { getDb } from '#db-client';
import {
  frameVariants,
  frames,
  generatedAssets,
  shots,
  shotVariants,
  sequenceElements,
  sequences,
} from '@/lib/db/schema';
import { resolveRunState, STALE_THRESHOLD_MS } from '@/lib/workflow/reconcile';
import { and, eq, inArray, isNotNull, isNull, lt } from 'drizzle-orm';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'cron', 'reconcile-all']);

const BLIND_FAIL_THRESHOLD_MS = 30 * 60 * 1000;
const MAX_ROWS_PER_PASS = 100;

type Database = ReturnType<typeof getDb>;
type ReconcileCounts = Record<string, number>;

/** Sentinel returned per pass in `ReconcileCounts` when the pass threw. */
export const PASS_ERRORED = -1;

/**
 * Top-level entry: run every pass sequentially. Errors in one pass don't stop
 * the others — the cron is best-effort. A failed pass records
 * `PASS_ERRORED` in the returned counts, distinguishable from a zero-update
 * pass.
 *
 * Always emits one summary log line per sweep so observability/alerting has a
 * single high-signal event per cron tick — without it, a systemic failure
 * (e.g. revoked QStash token making every per-row check throw) would look
 * identical to a clean sweep with nothing to do.
 */
export async function reconcileAllStuckJobs(): Promise<ReconcileCounts> {
  const db = getDb();
  const counts: ReconcileCounts = {};

  const passes: Array<[string, () => Promise<number>]> = [
    // Image lives on frames / frame_variants now (#989).
    ['frames.image', () => reconcileFramesImagePass(db)],
    ['shots.video', () => reconcileShotsPass(db, 'video')],
    ['frame_variants.status', () => reconcileFrameVariantsPass(db)],
    ['shots.audio', () => reconcileShotsPass(db, 'audio')],
    ['shot_variants.status', () => reconcileShotVariantsPass(db, 'primary')],
    [
      'shot_variants.shot_variant',
      () => reconcileShotVariantsPass(db, 'shotVariant'),
    ],
    ['sequences.status', () => reconcileSequencesPass(db)],
    ['sequences.music', () => blindFailPass(db, 'sequencesMusic')],
    ['sequence_elements.vision', () => blindFailPass(db, 'sequenceElements')],
    // Direct model runs (#458) — verified pass plus an orphan pass for rows
    // whose trigger died before a workflowRunId was ever persisted.
    ['generated_assets.status', () => reconcileGeneratedAssetsPass(db)],
    ['generated_assets.orphaned', () => failOrphanedGeneratedAssetsPass(db)],
  ];

  for (const [name, run] of passes) {
    try {
      counts[name] = await run();
    } catch (error) {
      logger.error(`${name} pass failed:`, {
        data: error instanceof Error ? error.message : error,
      });
      counts[name] = PASS_ERRORED;
    }
  }

  const failedPasses = Object.entries(counts)
    .filter(([, n]) => n === PASS_ERRORED)
    .map(([name]) => name);
  const totalReconciled = Object.values(counts)
    .filter((n) => n > 0)
    .reduce((sum, n) => sum + n, 0);

  if (failedPasses.length === passes.length) {
    logger.error('ALL passes failed', { counts });
  } else if (failedPasses.length > 0) {
    logger.warn('partial failure', { failedPasses, counts });
  } else if (totalReconciled > 0) {
    logger.info(`sweep complete: ${totalReconciled} row(s) reconciled`, {
      counts,
    });
  }

  return counts;
}

type ShotPipeline = 'video' | 'audio';

// Why we don't bump `updatedAt` on reconciler writes (applies to every pass
// in this file): the staleness predicate is `updated_at < cutoff`. If pass A
// updated `updated_at = now` while writing its status column, pass B's
// SELECT for the same row would see a fresh timestamp and skip it. So when a
// shot is stuck across multiple pipelines simultaneously, only the first
// pass would reconcile. Leaving `updated_at` untouched lets sequential
// passes all see the row as stale until each one has flipped its own
// status column. The on-load reconciler doesn't have this issue because it
// collects all stale entries from in-memory data before writing.
const SHOTS_PIPELINE_COLUMNS = {
  video: {
    status: shots.videoStatus,
    runId: shots.videoWorkflowRunId,
    setStatus: (next: 'failed' | 'completed') => ({ videoStatus: next }),
  },
  audio: {
    status: shots.audioStatus,
    runId: shots.audioWorkflowRunId,
    setStatus: (next: 'failed' | 'completed') => ({ audioStatus: next }),
  },
} as const;

/**
 * Reconcile stuck anchor-frame image generation (#989 — the old
 * `shots.thumbnail*` pass). Frame image status with a known workflow run id.
 */
async function reconcileFramesImagePass(db: Database): Promise<number> {
  const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
  const stuck = await db
    .select({ id: frames.id, runId: frames.imageWorkflowRunId })
    .from(frames)
    .where(
      and(
        eq(frames.imageStatus, 'generating'),
        lt(frames.updatedAt, staleCutoff)
      )
    )
    .limit(MAX_ROWS_PER_PASS);
  let updated = 0;
  for (const row of stuck) {
    const next = await resolveRunState(row.runId ?? '');
    if (next === null || next === 'unknown') continue;
    await db
      .update(frames)
      .set({ imageStatus: next })
      .where(eq(frames.id, row.id));
    updated++;
  }
  return updated;
}

/**
 * Reconcile stuck `frame_variants` versions (model re-rolls + the 3×3 grid /
 * upscaled framing tiles) — the image-variant analog of the retired
 * `shots.variant_image` pass.
 */
async function reconcileFrameVariantsPass(db: Database): Promise<number> {
  const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
  const stuck = await db
    .select({ id: frameVariants.id, runId: frameVariants.workflowRunId })
    .from(frameVariants)
    .where(
      and(
        eq(frameVariants.status, 'generating'),
        lt(frameVariants.updatedAt, staleCutoff)
      )
    )
    .limit(MAX_ROWS_PER_PASS);
  let updated = 0;
  for (const row of stuck) {
    const next = await resolveRunState(row.runId ?? '');
    if (next === null || next === 'unknown') continue;
    await db
      .update(frameVariants)
      .set({ status: next })
      .where(eq(frameVariants.id, row.id));
    // Drop auto-promote claim if this stuck version held it (#1070).
    if (next === 'failed') {
      await db
        .update(frames)
        .set({ pendingPromoteVersionId: null, updatedAt: new Date() })
        .where(eq(frames.pendingPromoteVersionId, row.id));
    }
    updated++;
  }
  return updated;
}

async function reconcileShotsPass(
  db: Database,
  pipeline: ShotPipeline
): Promise<number> {
  const cols = SHOTS_PIPELINE_COLUMNS[pipeline];
  const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MS);

  const stuck = await db
    .select({ id: shots.id, runId: cols.runId })
    .from(shots)
    .where(and(eq(cols.status, 'generating'), lt(shots.updatedAt, staleCutoff)))
    .limit(MAX_ROWS_PER_PASS);

  let updated = 0;
  for (const row of stuck) {
    const next = await resolveRunState(row.runId ?? '');
    // null = still in flight, 'unknown' = lookup failed — either way, don't
    // write a terminal status; the next sweep retries.
    if (next === null || next === 'unknown') continue;
    await db
      .update(shots)
      .set(cols.setStatus(next))
      .where(eq(shots.id, row.id));
    updated++;
  }
  return updated;
}

type ShotVariantsPipeline = 'primary' | 'shotVariant';

async function reconcileShotVariantsPass(
  db: Database,
  pipeline: ShotVariantsPipeline
): Promise<number> {
  const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MS);

  const stuck =
    pipeline === 'primary'
      ? await db
          .select({ id: shotVariants.id, runId: shotVariants.workflowRunId })
          .from(shotVariants)
          .where(
            and(
              eq(shotVariants.status, 'generating'),
              lt(shotVariants.updatedAt, staleCutoff)
            )
          )
          .limit(MAX_ROWS_PER_PASS)
      : await db
          .select({
            id: shotVariants.id,
            runId: shotVariants.shotVariantWorkflowRunId,
          })
          .from(shotVariants)
          .where(
            and(
              eq(shotVariants.shotVariantStatus, 'generating'),
              lt(shotVariants.updatedAt, staleCutoff)
            )
          )
          .limit(MAX_ROWS_PER_PASS);

  let updated = 0;
  for (const row of stuck) {
    const next = await resolveRunState(row.runId ?? '');
    if (next === null || next === 'unknown') continue;
    if (pipeline === 'primary') {
      await db
        .update(shotVariants)
        .set({ status: next })
        .where(eq(shotVariants.id, row.id));
    } else {
      await db
        .update(shotVariants)
        .set({ shotVariantStatus: next })
        .where(eq(shotVariants.id, row.id));
    }
    updated++;
  }
  return updated;
}

/**
 * Heal sequences stuck in 'processing' whose /storyboard workflow died
 * without persisting an outcome (engine abort, waitForEvent timeout with a
 * pre-#839 log-only onFailure, eviction). Verified against the CF instance's
 * real status via the persisted `workflowRunId` — rows whose instance is
 * still in flight return `null` from `resolveRunState` and are left alone,
 * so a legitimately slow (multi-hour) generation is never falsely failed.
 *
 * Rows with a NULL `workflowRunId` (created before the column existed, or
 * whose trigger-site write failed) are skipped entirely: without a run id we
 * can't distinguish slow-but-alive from dead, and 'processing' has no safe
 * blind-fail threshold now that full runs can legitimately take hours.
 */
// Narrowly typed like SHOTS_PIPELINE_COLUMNS.setStatus so the compiler
// enforces the null/'unknown' skip in the loop below: dropping either guard
// makes this call fail typecheck instead of silently flipping a live (or
// unverifiable) sequence to 'completed'.
const setSequenceStatus = (next: 'failed' | 'completed') =>
  next === 'failed'
    ? {
        status: 'failed' as const,
        statusError: 'Generation was interrupted — use Retry to run it again.',
      }
    : { status: 'completed' as const };

async function reconcileSequencesPass(db: Database): Promise<number> {
  const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MS);

  const stuck = await db
    .select({ id: sequences.id, runId: sequences.workflowRunId })
    .from(sequences)
    .where(
      and(
        eq(sequences.status, 'processing'),
        isNotNull(sequences.workflowRunId),
        lt(sequences.updatedAt, staleCutoff)
      )
    )
    .limit(MAX_ROWS_PER_PASS);

  let updated = 0;
  for (const row of stuck) {
    const next = await resolveRunState(row.runId ?? '');
    if (next === null || next === 'unknown') continue;
    await db
      .update(sequences)
      .set(setSequenceStatus(next))
      .where(eq(sequences.id, row.id));
    updated++;
  }
  return updated;
}

// Narrowly typed like `setSequenceStatus` so dropping the null/'unknown'
// guard in the loop fails typecheck. A verified-'completed' instance whose
// row is still queued/running means `markCompleted` never landed — the
// outputs can't be recovered here, so the honest terminal state is 'failed'
// with a retry hint, never a fabricated 'completed' without outputs.
const setGeneratedAssetStatus = (next: 'failed' | 'completed') =>
  next === 'failed'
    ? {
        status: 'failed' as const,
        error: 'Generation was interrupted — run it again.',
      }
    : {
        status: 'failed' as const,
        error:
          'The generation finished but its result was not saved — run it again.',
      };

/**
 * Heal `generated_assets` rows stuck in 'queued'/'running' whose workflow
 * died without persisting an outcome, verified against the CF instance via
 * the persisted `workflowRunId` (same shape as the sequences pass).
 */
async function reconcileGeneratedAssetsPass(db: Database): Promise<number> {
  const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MS);

  const stuck = await db
    .select({ id: generatedAssets.id, runId: generatedAssets.workflowRunId })
    .from(generatedAssets)
    .where(
      and(
        inArray(generatedAssets.status, ['queued', 'running']),
        isNotNull(generatedAssets.workflowRunId),
        lt(generatedAssets.updatedAt, staleCutoff)
      )
    )
    .limit(MAX_ROWS_PER_PASS);

  let updated = 0;
  for (const row of stuck) {
    const next = await resolveRunState(row.runId ?? '');
    if (next === null || next === 'unknown') continue;
    await db
      .update(generatedAssets)
      .set(setGeneratedAssetStatus(next))
      .where(eq(generatedAssets.id, row.id));
    updated++;
  }
  return updated;
}

/**
 * Blind-fail `generated_assets` rows stuck 'queued' with NO `workflowRunId`.
 * The create fn marks the row failed when the trigger throws, so this only
 * catches the residue (crash between insert and that catch, or a failed
 * `setWorkflowRunId` write whose workflow then also died before its own
 * first write). A live workflow flips the row to 'running' within seconds,
 * so 'queued' after 30 minutes with no run id is safely dead.
 */
async function failOrphanedGeneratedAssetsPass(db: Database): Promise<number> {
  const staleCutoff = new Date(Date.now() - BLIND_FAIL_THRESHOLD_MS);

  const result = await db
    .update(generatedAssets)
    .set({
      status: 'failed',
      error: 'The generation could not be started — please try again.',
    })
    .where(
      and(
        eq(generatedAssets.status, 'queued'),
        isNull(generatedAssets.workflowRunId),
        lt(generatedAssets.updatedAt, staleCutoff)
      )
    )
    .returning({ id: generatedAssets.id });
  return result.length;
}

type BlindFailPipeline = 'sequencesMusic' | 'sequenceElements';

/**
 * Tables without a workflow_run_id column: we can't ask QStash what happened.
 * After a longer threshold we mark them failed so the user can retry.
 *
 * Why 30min vs the 5min QStash-verified threshold: with no run id we can't
 * distinguish a slow-but-alive run from a dead one, so we wait long enough
 * that any reasonable workflow would have completed (the slowest current
 * workflows — music gen and element vision — finish well under 30min).
 * Note we can only flip to 'failed' here, never 'completed' — without a run
 * id, success requires the workflow's own update step to have persisted, and
 * if that didn't happen the artifact URL won't be there either.
 */
async function blindFailPass(
  db: Database,
  pipeline: BlindFailPipeline
): Promise<number> {
  const staleCutoff = new Date(Date.now() - BLIND_FAIL_THRESHOLD_MS);

  if (pipeline === 'sequencesMusic') {
    const result = await db
      .update(sequences)
      .set({ musicStatus: 'failed' })
      .where(
        and(
          eq(sequences.musicStatus, 'generating'),
          lt(sequences.updatedAt, staleCutoff)
        )
      )
      .returning({ id: sequences.id });
    return result.length;
  }

  // sequenceElements
  const result = await db
    .update(sequenceElements)
    .set({ visionStatus: 'failed' })
    .where(
      and(
        eq(sequenceElements.visionStatus, 'analyzing'),
        lt(sequenceElements.updatedAt, staleCutoff)
      )
    )
    .returning({ id: sequenceElements.id });
  return result.length;
}
