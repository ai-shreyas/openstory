/**
 * Per-shot staleness computation (#1077) — shared by the `getShotStaleness*`
 * server fns and `UpdateStaleShotsWorkflow` (#1085). Each value is computed by
 * re-deriving the current input hash from live scoped state and comparing it
 * to the stored `*_input_hash`.
 */

import { DEFAULT_IMAGE_MODEL, safeTextToImageModel } from '@/lib/ai/models';
import {
  computeMotionPromptInputHash,
  computeVisualPromptInputHash,
} from '@/lib/ai/input-hash';
import {
  loadNarrowShotPromptContext,
  type ShotPromptContextRefs,
  type ShotPromptContextSequence,
} from '@/lib/ai/prompt-context';
import type { Scene } from '@/lib/ai/scene-analysis.schema';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import type { Frame, FrameVariant, Shot } from '@/lib/db/schema';
import type { SequenceStatus } from '@/lib/db/schema/sequences';
import type { ScopedDb } from '@/lib/db/scoped';
import { buildRegenerateShotSnapshot } from '@/lib/workflows/regenerate-shots-snapshot';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'shots', 'staleness']);

/**
 * Per-artifact staleness. Shared vocabulary — the client re-exports this type
 * rather than redeclaring it, so the two can't drift.
 *
 * `'updating'` (#1085): the stored hash diverges from live, but a live pending
 * claim (a pre-created `pending`/`generating` version row) exists whose
 * `pendingInputHash` equals the live hash — a job is already fixing exactly
 * this. Claims self-invalidate on edit: the live hash moves, the claim no
 * longer matches, and the artifact honestly reads 'stale' again.
 *
 * `'generating'` (#1121): the sequence itself is mid-run. See
 * `computeShotStaleness`'s early return.
 */
export type ArtifactStaleness =
  | 'stale'
  | 'fresh'
  | 'updating'
  | 'generating'
  | 'untracked'
  | 'unknown';

/**
 * The live input hashes computed during the comparison. Enqueue points reuse
 * them to stamp pending claims without recomputing; null when the branch
 * didn't run (untracked/unknown artifacts).
 */
type ShotLiveHashes = {
  thumbnail: string | null;
  visualPrompt: string | null;
  motionPrompt: string | null;
};

export type ShotStalenessResult = {
  thumbnail: ArtifactStaleness;
  visualPrompt: ArtifactStaleness;
  motionPrompt: ArtifactStaleness;
  liveHashes: ShotLiveHashes;
};

/** Every artifact unopinionated — the missing-anchor and no-scene cases. */
export const UNTRACKED_STALENESS: ShotStalenessResult = {
  thumbnail: 'untracked',
  visualPrompt: 'untracked',
  motionPrompt: 'untracked',
  liveHashes: { thumbnail: null, visualPrompt: null, motionPrompt: null },
};

/** Every artifact deferred — the sequence is mid-run (#1121). */
const GENERATING_STALENESS: ShotStalenessResult = {
  thumbnail: 'generating',
  visualPrompt: 'generating',
  motionPrompt: 'generating',
  liveHashes: { thumbnail: null, visualPrompt: null, motionPrompt: null },
};

/**
 * The one status that means "a run owns this sequence's artifacts right now":
 * `triggerStoryboard` is the only writer (create / retry / regenerate), and it
 * rebuilds every shot. Nothing else — a shot regenerate, an Update all run —
 * moves the sequence off 'completed', so this never suppresses a genuine
 * post-edit staleness verdict.
 */
const isSequenceGenerating = (status: SequenceStatus): boolean =>
  status === 'processing';

/** Sequence-scoped rows loaded once for a batch of shot comparisons. */
export type ShotStalenessRefs = ShotPromptContextRefs;

/**
 * Five states per artifact:
 *   - `'stale'`     — stored hash diverges from the freshly computed one.
 *   - `'fresh'`     — stored hash matches.
 *   - `'updating'`  — stored hash diverges, but a live pending claim matches
 *                     the live hash — a job is already fixing exactly this
 *                     (see the overlay at the end of this function, #1085).
 *   - `'untracked'` — no stored hash (legacy artifact, or never generated).
 *                     Distinct from `'fresh'` so the UI can suppress the
 *                     regenerate prompt without lying about the artifact's
 *                     freshness.
 *   - `'generating'`— the sequence is mid-generation run (#1121); see the
 *                     early return below.
 *   - `'unknown'`   — the comparison itself failed (style deleted mid-flight,
 *                     transient D1 read, malformed row). Distinct from
 *                     `'untracked'`: the UI renders it as "couldn't check"
 *                     rather than as silence, so a broken comparison never
 *                     reads as "up to date". WRITE paths must not treat "we
 *                     couldn't tell" as "nothing to do" — `computePlan`
 *                     (update-stale-plan) reports these as skipped rather than
 *                     silently dropping a possibly-stale artifact.
 *
 * `refs` lets batched callers load the sequence-scoped rows once for the whole
 * scene/sequence instead of once per shot; when absent they are loaded lazily.
 */
export async function computeShotStaleness(args: {
  scopedDb: ScopedDb;
  sequence: ShotPromptContextSequence & {
    aspectRatio: AspectRatio;
    status: SequenceStatus;
  };
  shot: Shot;
  frame: Frame;
  /**
   * The `frame_variants` row the frame's selection points at — the still's
   * url / model / inputHash live there since #1067, not on the frame. Passed in
   * (not looked up here) so the batch caller resolves them all in one read.
   */
  selectedImage: FrameVariant | null;
  scene: Scene | null;
  refs?: ShotStalenessRefs;
}): Promise<ShotStalenessResult> {
  const { scopedDb, sequence, shot, frame, selectedImage, scene, refs } = args;

  // ============================================================
  // Mid-run short-circuit (#1121). Every comparison below pits a hash stamped
  // at some earlier moment against one recomputed from live scoped state. That
  // is only a statement about the user's edits once the sequence has settled:
  // during a storyboard run the inputs the hashes are taken over — cast rows,
  // locations, elements, and therefore the narrowed bibles
  // `loadNarrowShotPromptContext` derives — are still being written, so a
  // prompt stamped against the context of five minutes ago legitimately
  // diverges from the context of now, and the run itself is what closes the
  // gap (the pipeline writes a final version against the settled context,
  // which is why the banner used to clear on its own at the end).
  //
  // Reporting that as 'stale' told the user "out of date since your edit" when
  // they had not edited anything, and offered "Update all" — regenerating,
  // for real money, artifacts the running pipeline was about to overwrite.
  // 'generating' is the honest answer: no verdict, no action, and the client
  // predicates (`shotIsStale`/`shotIsUpdating`/`shotStalenessUnknown`) all
  // ignore it, so nothing renders. Returned BEFORE any read: the batch fn
  // recomputes hashes for every shot in the sequence on a poll loop that runs
  // hardest during exactly this window.
  // ============================================================
  if (isSequenceGenerating(sequence.status)) return GENERATING_STALENESS;

  const liveHashes: ShotLiveHashes = {
    thumbnail: null,
    visualPrompt: null,
    motionPrompt: null,
  };
  let thumbnail: ArtifactStaleness = 'untracked';
  const selectedPrompt = await scopedDb.framePromptVersions.getSelected(
    frame.id
  );
  const effectivePrompt = selectedPrompt?.text ?? null;
  if (effectivePrompt) {
    // Distinguish "stored hash absent" from "stored hash matches". No selected
    // version, or a version with a null hash (the image predates hash tracking,
    // or came from a pre-fix `generateShotImageFn` that didn't pass a
    // sceneSnapshot), means we genuinely have no opinion — so 'untracked'
    // rather than lying with 'fresh'. Once the user regenerates once under the
    // new path the version carries a hash and the comparison takes over.
    if (selectedImage?.inputHash == null) {
      thumbnail = 'untracked';
    } else {
      try {
        const [characters, locations, elements] = refs
          ? [refs.characters, refs.locations, refs.elements]
          : await Promise.all([
              scopedDb.characters.listWithSheets(sequence.id),
              scopedDb.sequenceLocations.listWithReferences(sequence.id),
              scopedDb.sequenceElements.list(sequence.id),
            ]);

        const snapshot = await buildRegenerateShotSnapshot({
          shot,
          scene,
          frameId: frame.id,
          imagePrompt: effectivePrompt,
          characters,
          locations,
          elements,
          imageModel: safeTextToImageModel(
            selectedImage.model,
            DEFAULT_IMAGE_MODEL
          ),
          aspectRatio: sequence.aspectRatio,
        });

        liveHashes.thumbnail = snapshot.snapshotInputHash;
        thumbnail =
          snapshot.snapshotInputHash !== selectedImage.inputHash
            ? 'stale'
            : 'fresh';
      } catch (error) {
        // Mirror the visual/motion branches: a thumbnail-hash failure (e.g.
        // transient D1 read, malformed element/location row) must not throw
        // out of the whole handler — that would null the entire staleness
        // result and silently suppress the visual/motion banners too. Report
        // 'unknown' (fail-open as 'fresh' would lie about freshness).
        thumbnail = 'unknown';
        logger.warn(`thumbnail staleness uncomputable for shot ${shot.id}:`, {
          err: error,
        });
      }
    }
  }

  let visualPrompt: ArtifactStaleness = 'untracked';
  let motionPrompt: ArtifactStaleness = 'untracked';

  // Reference hash resolution: prefer the SELECTED version's `inputHash`, but
  // fall back to the most recent version with a non-null one for prompts whose
  // selected row carries a null hash (a pre-fix user-edit, or the force-regen
  // path). Without the fallback, those are stuck at `'untracked'` permanently.
  if (scene) {
    // The fallback read is inside the try: it is exactly the transient-D1 case
    // the catch exists for, and outside it one bad read rejects the caller's
    // whole batch.
    try {
      let referenceHash = selectedPrompt?.inputHash ?? null;
      if (!referenceHash) {
        const fallback =
          await scopedDb.framePromptVersions.getLatestWithInputHash(frame.id);
        referenceHash = fallback?.inputHash ?? null;
      }
      if (referenceHash) {
        const latest = await scopedDb.framePromptVersions.getLatest(frame.id);
        const ctx = await loadNarrowShotPromptContext({
          scopedDb,
          sequence,
          scene,
          analysisModelOverride: latest?.analysisModel ?? null,
          refs,
        });
        const liveHash = await computeVisualPromptInputHash(ctx);
        liveHashes.visualPrompt = liveHash;
        visualPrompt = liveHash !== referenceHash ? 'stale' : 'fresh';
      }
    } catch (error) {
      // Context unavailable (e.g., style deleted mid-flight). Report
      // 'unknown' — fail-open as 'fresh' would silently lie to the user.
      visualPrompt = 'unknown';
      logger.warn(`visual staleness uncomputable for shot ${shot.id}:`, {
        err: error,
      });
    }
  }

  if (scene) {
    try {
      let referenceHash =
        (await scopedDb.shotPromptVersions.getSelectedMotion(shot.id))
          ?.inputHash ?? null;
      if (!referenceHash) {
        const fallback =
          await scopedDb.shotPromptVersions.getLatestWithInputHash(
            shot.id,
            'motion'
          );
        referenceHash = fallback?.inputHash ?? null;
      }
      if (referenceHash) {
        const latest = await scopedDb.shotPromptVersions.getLatest(
          shot.id,
          'motion'
        );
        const ctx = await loadNarrowShotPromptContext({
          scopedDb,
          sequence,
          scene,
          analysisModelOverride: latest?.analysisModel ?? null,
          startingFrameImageUrl: selectedImage?.url ?? null,
          refs,
        });
        const liveHash = await computeMotionPromptInputHash(ctx);
        liveHashes.motionPrompt = liveHash;
        motionPrompt = liveHash !== referenceHash ? 'stale' : 'fresh';
      }
    } catch (error) {
      motionPrompt = 'unknown';
      logger.warn(`motion staleness uncomputable for shot ${shot.id}:`, {
        err: error,
      });
    }
  }

  // ============================================================
  // 'updating' overlay (#1085): a stale artifact with a live pending claim
  // whose pendingInputHash equals the live hash is already being fixed.
  // Runs last so the thumbnail's chained-claim check can use the visual
  // prompt's live hash computed above.
  // ============================================================
  if (visualPrompt === 'stale' && liveHashes.visualPrompt) {
    const claim = await scopedDb.framePromptVersions.getLivePending(
      frame.id,
      liveHashes.visualPrompt
    );
    if (claim) visualPrompt = 'updating';
  }
  if (motionPrompt === 'stale' && liveHashes.motionPrompt) {
    const claim = await scopedDb.shotPromptVersions.getLivePending(
      shot.id,
      liveHashes.motionPrompt
    );
    if (claim) motionPrompt = 'updating';
  }
  if (thumbnail === 'stale' && liveHashes.thumbnail) {
    const claims = await scopedDb.frameVariants.listLiveClaims(frame.id);
    for (const claim of claims) {
      // Direct regen: the claim satisfies the image's live hash itself.
      if (claim.pendingInputHash === liveHashes.thumbnail) {
        thumbnail = 'updating';
        break;
      }
      // Chained regen: validity derives from the dependency prompt row. While
      // the prompt is in flight its claim must match the live VISUAL hash;
      // once it completes (render still pending/running) its stamped
      // inputHash must — either way an edit moves the live hash and honestly
      // re-stales the image.
      if (claim.dependsOnVersionId && liveHashes.visualPrompt) {
        const dep = await scopedDb.framePromptVersions.getByIdForFrame(
          claim.dependsOnVersionId,
          frame.id
        );
        if (!dep) continue;
        const depInFlight =
          (dep.status === 'pending' || dep.status === 'generating') &&
          dep.pendingInputHash === liveHashes.visualPrompt;
        const depLanded =
          dep.status === 'completed' &&
          dep.inputHash === liveHashes.visualPrompt;
        if (depInFlight || depLanded) {
          thumbnail = 'updating';
          break;
        }
      }
    }
  }

  return { thumbnail, visualPrompt, motionPrompt, liveHashes };
}
