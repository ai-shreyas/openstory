/**
 * Scoped Frame Prompt Versions Sub-module (image / visual prompt history).
 *
 * Appends a revision to `frame_prompt_versions` and mirrors the current value
 * onto the frame: `frames.imagePrompt` (text), `frames.visualPromptInputHash`
 * (staleness), and the `frames.selectedImagePromptVersionId` pointer. The
 * frame-side sibling of `shot_prompt_versions` (motion prompt).
 *
 * Like the shot-prompt path, the append + mirror pair is sequential, not
 * transactional: the version row is the source of truth and the cached columns
 * are a read-path optimization. AI rows dedupe on the partial unique index
 * `(frame_id, input_hash) WHERE input_hash IS NOT NULL AND source != 'restored'`
 * so workflow retries don't double-append; a force-regen against unchanged
 * inputs falls back to a null-hash row so the new text still lands in history.
 *
 * See docs/architecture/workflow-snapshots-and-content-hash-staleness.md
 * § prompt versioning and docs/architecture/scene-shot-frame-redesign.md.
 */

import type { VisualPromptComponents } from '@/lib/ai/scene-analysis.schema';
import type { Database } from '@/lib/db/client';
import { framePromptVersions, frames, user } from '@/lib/db/schema';
import type { FramePromptVersion } from '@/lib/db/schema';
import { and, desc, eq, gt, inArray, isNotNull, ne } from 'drizzle-orm';
import { buildEventInsert } from './sequence-events';

/** Statuses of an in-flight pending claim — not yet terminal. */
export const LIVE_PENDING_STATUSES = ['pending', 'generating'] as const;

type WriteFramePromptVersionBase = {
  frameId: string;
  text: string;
  components?: VisualPromptComponents | null;
  createdBy?: string | null;
};

/**
 * `inputHash` is the upstream context (scene + style + narrowed bibles +
 * aspectRatio + analysisModel) the prompt aligns with. AI / regenerated rows
 * must carry a real hash + analysis model so the cached
 * `visual_prompt_input_hash` keeps staleness detection alive; user-edits and
 * restores may carry null when context was uncomputable. Restores carry the
 * source version's hash + model verbatim so restoring an old AI prompt does
 * not silently disable staleness.
 */
export type WriteFramePromptVersionInput = WriteFramePromptVersionBase &
  (
    | {
        source: 'ai-generated' | 'regenerated';
        inputHash: string;
        analysisModel: string;
      }
    | {
        source: 'user-edit';
        inputHash: string | null;
        analysisModel: string | null;
      }
    | {
        source: 'restored';
        inputHash: string | null;
        analysisModel: string | null;
      }
  );

export function createFramePromptVersionsMethods(db: Database) {
  /** Point the frame at `version` and mirror its text/hash onto the frame. */
  const mirrorOntoFrame = (frameId: string, version: FramePromptVersion) =>
    db
      .update(frames)
      .set({
        imagePrompt: version.text,
        visualPromptInputHash: version.inputHash,
        selectedImagePromptVersionId: version.id,
        updatedAt: new Date(),
      })
      .where(eq(frames.id, frameId));

  /**
   * Revoke the mirror right of every live claim on this frame (#1085): after
   * an explicit user repoint (restore / image-selection prompt restore / edit),
   * an in-flight regeneration may still land in history but must NOT overwrite
   * the user's choice on the frame. Nulling `pendingInputHash` is the
   * revocation — completion mirrors only claims that still hold their hash,
   * and the artifact honestly reads 'stale' again instead of 'updating'.
   * Also frees the live-claim unique index slot so a fresh enqueue for a new
   * hash is not blocked by a demoted-but-still-running claim.
   */
  const demoteLiveClaims = (frameId: string) =>
    db
      .update(framePromptVersions)
      .set({ pendingInputHash: null })
      .where(
        and(
          eq(framePromptVersions.frameId, frameId),
          inArray(framePromptVersions.status, [...LIVE_PENDING_STATUSES])
        )
      );

  /**
   * Post-transition mirror check for completePendingAiVersion (#1095 TOCTOU).
   * Must run AFTER the claim has been moved terminal so a concurrent demote
   * (nulls pendingInputHash while live) or a concurrent write (inserts a
   * newer completed ULID) is visible before we touch the frame mirror.
   */
  const stillHoldsMirrorRight = async (
    frameId: string,
    claimId: string
  ): Promise<boolean> => {
    const [row] = await db
      .select({ pendingInputHash: framePromptVersions.pendingInputHash })
      .from(framePromptVersions)
      .where(eq(framePromptVersions.id, claimId))
      .limit(1);
    if (!row || row.pendingInputHash === null) return false;
    // ULID ids order by creation time: any completed row newer than the claim
    // is a post-click edit (or a later run) that must keep the mirror.
    const [newer] = await db
      .select({ id: framePromptVersions.id })
      .from(framePromptVersions)
      .where(
        and(
          eq(framePromptVersions.frameId, frameId),
          eq(framePromptVersions.status, 'completed'),
          gt(framePromptVersions.id, claimId)
        )
      )
      .limit(1);
    return !newer;
  };

  const methods = {
    /**
     * Append a prompt version and mirror it onto the frame (text, hash, and
     * the selected-pointer). Returns the inserted (or pre-existing matching)
     * row. See the module docstring for the dedupe / force-regen contract.
     */
    write: async (
      input: WriteFramePromptVersionInput
    ): Promise<FramePromptVersion> => {
      const nextHash = input.inputHash;
      const analysisModel = input.analysisModel;

      const [inserted] = await db
        .insert(framePromptVersions)
        .values({
          frameId: input.frameId,
          text: input.text,
          components: input.components,
          source: input.source,
          inputHash: nextHash,
          analysisModel,
          createdBy: input.createdBy ?? null,
        })
        .onConflictDoNothing()
        .returning();

      let version: FramePromptVersion | undefined = inserted;
      if (!version && nextHash !== null) {
        const [existing] = await db
          .select()
          .from(framePromptVersions)
          .where(
            and(
              eq(framePromptVersions.frameId, input.frameId),
              eq(framePromptVersions.inputHash, nextHash)
            )
          )
          .limit(1);

        if (existing && existing.text !== input.text) {
          // Same upstream hash, genuinely new text. Two ways to get here: a
          // force-regen (AI runs against unchanged inputs) or a user-edit whose
          // live hash matches the row it edits. Either way the new text must
          // land in history, so bypass the partial unique index with a null
          // input_hash; the cached hash below still tracks the real context.
          // (`restored` rows never reach this branch — the index excludes them,
          // so their insert never conflicts.)
          const [forced] = await db
            .insert(framePromptVersions)
            .values({
              frameId: input.frameId,
              text: input.text,
              components: input.components,
              source: input.source,
              inputHash: null,
              analysisModel,
              createdBy: input.createdBy ?? null,
            })
            .returning();
          version = forced;
        } else {
          version = existing;
        }
      }

      if (!version) {
        throw new Error('Failed to insert frame prompt version');
      }

      // Mirror the edit onto the frame, then revoke in-flight claims' mirror
      // rights so a concurrent completePendingAiVersion cannot clobber this
      // write (#1085 / #1095 TOCTOU). demote nulls pendingInputHash (and
      // frees the live-claim unique slot) while claims stay pending/generating.
      await db.batch([
        db
          .update(frames)
          .set({
            imagePrompt: input.text,
            visualPromptInputHash: nextHash,
            selectedImagePromptVersionId: version.id,
            updatedAt: new Date(),
          })
          .where(eq(frames.id, input.frameId)),
        demoteLiveClaims(input.frameId),
      ]);

      return version;
    },

    /**
     * Append an AI-generated visual prompt version, deciding `ai-generated`
     * (first version for the frame) vs `regenerated` (a re-run) from the
     * frame's existing history — so callers (the generation workflow) don't
     * compute `source` or chase `getLatest` themselves. Appends + mirrors via
     * `write`. The dedupe/force-regen contract is `write`'s.
     */
    writeAiVersion: async (input: {
      frameId: string;
      text: string;
      components?: VisualPromptComponents | null;
      inputHash: string;
      analysisModel: string;
      createdBy?: string | null;
    }): Promise<FramePromptVersion> => {
      const previous = await methods.getLatest(input.frameId);
      return methods.write({
        ...input,
        source: previous ? 'regenerated' : 'ai-generated',
      });
    },

    /**
     * Create an in-flight placeholder row for a regeneration that was just
     * enqueued (#1085). Deliberately does NOT mirror onto the frame or move
     * the selection pointer — only completion does that — so the pointer
     * invariant ("selected always points at a completed row") holds by
     * construction. `inputHash` stays null until completion, keeping the row
     * out of the partial unique index and out of every hash-matching reader.
     */
    createPending: async (input: {
      frameId: string;
      pendingInputHash: string;
      workflowRunId?: string | null;
      createdBy?: string | null;
    }): Promise<FramePromptVersion> => {
      const [row] = await db
        .insert(framePromptVersions)
        .values({
          frameId: input.frameId,
          text: '',
          source: 'regenerated',
          inputHash: null,
          analysisModel: null,
          status: 'pending',
          pendingInputHash: input.pendingInputHash,
          workflowRunId: input.workflowRunId ?? null,
          createdBy: input.createdBy ?? null,
        })
        .returning();
      if (!row) throw new Error('Failed to insert pending frame prompt row');
      return row;
    },

    /**
     * The newest live (pending/generating) claim for this frame satisfying
     * `pendingInputHash` — the dedup + "updating" staleness probe. A claim
     * whose hash no longer matches the live inputs is dead weight (the edit
     * self-invalidated it) and is deliberately not returned.
     */
    getLivePending: async (
      frameId: string,
      pendingInputHash: string
    ): Promise<FramePromptVersion | null> => {
      const [row] = await db
        .select()
        .from(framePromptVersions)
        .where(
          and(
            eq(framePromptVersions.frameId, frameId),
            eq(framePromptVersions.pendingInputHash, pendingInputHash),
            inArray(framePromptVersions.status, [...LIVE_PENDING_STATUSES])
          )
        )
        .orderBy(desc(framePromptVersions.createdAt))
        .limit(1);
      return row ?? null;
    },

    /**
     * Transition a claim to 'generating' and stamp the instance doing the
     * work. No-ops (returns false) when the row was cancelled meanwhile —
     * the caller must then abandon the generation.
     */
    markGenerating: async (
      versionId: string,
      workflowRunId: string
    ): Promise<boolean> => {
      const updated = await db
        .update(framePromptVersions)
        .set({ status: 'generating', workflowRunId })
        .where(
          and(
            eq(framePromptVersions.id, versionId),
            inArray(framePromptVersions.status, [...LIVE_PENDING_STATUSES])
          )
        )
        .returning({ id: framePromptVersions.id });
      return updated.length > 0;
    },

    /**
     * Terminal-fail a live claim (workflow failure / zombie sweep / cancel).
     * Returns the row when the transition happened, null when the row was
     * already terminal (e.g. completed just before a cancel raced in).
     */
    markTerminal: async (
      versionId: string,
      status: 'failed' | 'cancelled'
    ): Promise<FramePromptVersion | null> => {
      const [row] = await db
        .update(framePromptVersions)
        .set({ status })
        .where(
          and(
            eq(framePromptVersions.id, versionId),
            inArray(framePromptVersions.status, [...LIVE_PENDING_STATUSES])
          )
        )
        .returning();
      return row ?? null;
    },

    /**
     * Complete a pending claim in place: fill in the generated content, stamp
     * the hash of the inputs actually used, and flip to 'completed'. Mirrors
     * onto the frame ONLY when no newer completed version landed meanwhile —
     * a post-click user edit must never be clobbered by an older run's output
     * (#1085: "the system cannot lose an edit"). Returns null when the claim
     * was cancelled mid-flight (the output is discarded).
     *
     * Handles the partial-unique-index edge exactly like `write`: if a
     * completed row already carries this (frameId, inputHash), the claim
     * either retires in favour of that row (identical text) or completes with
     * a null row-hash (new text, index bypass) while the frame's cached hash
     * still tracks the real context.
     */
    completePendingAiVersion: async (input: {
      versionId: string;
      frameId: string;
      text: string;
      components?: VisualPromptComponents | null;
      inputHash: string;
      analysisModel: string;
    }): Promise<FramePromptVersion | null> => {
      const [claim] = await db
        .select()
        .from(framePromptVersions)
        .where(
          and(
            eq(framePromptVersions.id, input.versionId),
            eq(framePromptVersions.frameId, input.frameId)
          )
        )
        .limit(1);
      if (!claim) {
        throw new Error(
          `FramePromptVersion ${input.versionId} not found for frame ${input.frameId}`
        );
      }

      const [conflicting] = await db
        .select()
        .from(framePromptVersions)
        .where(
          and(
            eq(framePromptVersions.frameId, input.frameId),
            eq(framePromptVersions.inputHash, input.inputHash),
            ne(framePromptVersions.id, input.versionId),
            ne(framePromptVersions.source, 'restored')
          )
        )
        .limit(1);

      if (conflicting && conflicting.text === input.text) {
        // Identical output already in history — retire the placeholder. The
        // guarded UPDATE must have transitioned the claim ourselves: a no-op
        // means a cancel already won the race, and cancelled work must not
        // mirror (same contract as the main branch below).
        // status 'cancelled' here = retired duplicate placeholder (no new
        // content), not a user cancel.
        const retired = await db
          .update(framePromptVersions)
          .set({ status: 'cancelled' })
          .where(
            and(
              eq(framePromptVersions.id, input.versionId),
              inArray(framePromptVersions.status, [...LIVE_PENDING_STATUSES])
            )
          )
          .returning({ id: framePromptVersions.id });
        if (retired.length === 0) return null;
        // Re-evaluate mirror right AFTER the terminal transition so a
        // concurrent write/select that demoted us or landed a newer
        // completed row wins (#1095 TOCTOU).
        if (await stillHoldsMirrorRight(input.frameId, claim.id)) {
          await mirrorOntoFrame(input.frameId, conflicting);
        }
        return conflicting;
      }

      const [updated] = await db
        .update(framePromptVersions)
        .set({
          text: input.text,
          components: input.components ?? null,
          inputHash: conflicting ? null : input.inputHash,
          analysisModel: input.analysisModel,
          status: 'completed',
        })
        .where(
          and(
            eq(framePromptVersions.id, input.versionId),
            inArray(framePromptVersions.status, [...LIVE_PENDING_STATUSES])
          )
        )
        .returning();
      if (!updated) return null; // cancelled mid-flight — discard the output

      // Mirror right (#1085): re-checked after we own the terminal write.
      // Revoked when a newer completed row landed (post-click edit) or when
      // write/select demoted the claim (pendingInputHash nulled) — either
      // way the user's choice wins and this run's output goes to history only.
      if (await stillHoldsMirrorRight(input.frameId, claim.id)) {
        await db
          .update(frames)
          .set({
            imagePrompt: input.text,
            visualPromptInputHash: input.inputHash,
            selectedImagePromptVersionId: updated.id,
            updatedAt: new Date(),
          })
          .where(eq(frames.id, input.frameId));
      }
      return updated;
    },

    /**
     * Repoint the frame at an existing prompt version (a restore) and mirror
     * it onto the frame, committing the change and a `prompt.selected` event
     * in one batch. Returns the selected version.
     */
    select: async (
      frameId: string,
      versionId: string,
      opts: { actorId: string | null }
    ): Promise<FramePromptVersion> => {
      const [version] = await db
        .select()
        .from(framePromptVersions)
        .where(
          and(
            eq(framePromptVersions.id, versionId),
            eq(framePromptVersions.frameId, frameId)
          )
        );
      if (!version) {
        throw new Error(
          `FramePromptVersion ${versionId} not found for frame ${frameId}`
        );
      }
      if (version.status !== 'completed') {
        // Same invariant as frameVariants.select: the selection pointer (and
        // the frame mirror behind it) may only ever reference completed rows.
        throw new Error(
          `FramePromptVersion ${versionId} is ${version.status}, not completed`
        );
      }
      const [frame] = await db
        .select({
          sequenceId: frames.sequenceId,
          prev: frames.selectedImagePromptVersionId,
        })
        .from(frames)
        .where(eq(frames.id, frameId));
      if (!frame) {
        throw new Error(`Frame ${frameId} not found`);
      }

      await db.batch([
        mirrorOntoFrame(frameId, version),
        // An explicit repoint revokes in-flight claims' mirror rights (#1085)
        // — their output still lands in history, but must not clobber this.
        demoteLiveClaims(frameId),
        buildEventInsert(db, {
          sequenceId: frame.sequenceId,
          actorId: opts.actorId,
          kind: 'prompt.selected',
          targetType: 'frame',
          targetId: frameId,
          summary: 'Restored image prompt',
          data: { versionId, prevVersionId: frame.prev ?? null },
        }),
      ]);
      return version;
    },

    /** Revision history for a frame's image prompt, newest first. */
    listByFrame: async (frameId: string): Promise<FramePromptVersion[]> => {
      return await db
        .select()
        .from(framePromptVersions)
        .where(eq(framePromptVersions.frameId, frameId))
        .orderBy(desc(framePromptVersions.createdAt));
    },

    /** History list for the UI — joins author name. Newest first. */
    listByFrameWithAuthor: async (
      frameId: string
    ): Promise<
      Array<FramePromptVersion & { createdByName: string | null }>
    > => {
      const rows = await db
        .select({ version: framePromptVersions, createdByName: user.name })
        .from(framePromptVersions)
        .leftJoin(user, eq(framePromptVersions.createdBy, user.id))
        .where(eq(framePromptVersions.frameId, frameId))
        .orderBy(desc(framePromptVersions.createdAt));
      return rows.map((r) => ({
        ...r.version,
        createdByName: r.createdByName,
      }));
    },

    /** Fetch a single version scoped to its frame. */
    getByIdForFrame: async (
      versionId: string,
      frameId: string
    ): Promise<FramePromptVersion | null> => {
      const [row] = await db
        .select()
        .from(framePromptVersions)
        .where(
          and(
            eq(framePromptVersions.id, versionId),
            eq(framePromptVersions.frameId, frameId)
          )
        )
        .limit(1);
      return row ?? null;
    },

    /** Most recent completed version, or null. In-flight/failed rows are
     * placeholders, not content — every "latest" reader wants completed. */
    getLatest: async (frameId: string): Promise<FramePromptVersion | null> => {
      const [row] = await db
        .select()
        .from(framePromptVersions)
        .where(
          and(
            eq(framePromptVersions.frameId, frameId),
            eq(framePromptVersions.status, 'completed')
          )
        )
        .orderBy(desc(framePromptVersions.createdAt))
        .limit(1);
      return row ?? null;
    },

    /**
     * Most recent version with a non-null `inputHash` — the staleness path's
     * reference for frames whose cached hash was nulled by a context-less
     * user-edit. Mirrors `shotPromptVersions.getLatestWithInputHash`.
     */
    getLatestWithInputHash: async (
      frameId: string
    ): Promise<FramePromptVersion | null> => {
      const [row] = await db
        .select()
        .from(framePromptVersions)
        .where(
          and(
            eq(framePromptVersions.frameId, frameId),
            isNotNull(framePromptVersions.inputHash),
            eq(framePromptVersions.status, 'completed')
          )
        )
        .orderBy(desc(framePromptVersions.createdAt))
        .limit(1);
      return row ?? null;
    },
  };
  return methods;
}
