/**
 * Scoped Frame Variants Sub-module (flat, append-only image versions).
 *
 * Each row is ONE image generation — a *version*. A "variant" is the emergent
 * group of rows sharing `(frameId, kind, model, sourceVariantId)`; its
 * "versions" are those rows ordered by time (ULID). Re-rolls **accumulate** —
 * append never overwrites, so a video render manifest can reference a version
 * id as a stable snapshot.
 *
 * **Selection is a pointer, not a per-row flag.** The frame's current image is
 * whichever version `frames.selectedImageVersionId` points at; revert /
 * switch-model is a {@link select} repoint. `discardedAt` soft-hides a version
 * (undoable); there is no `divergedAt` (retired in the redesign).
 *
 * Every mutation commits its state change (the frame mirror for {@link select},
 * the `discardedAt` write for discard / undiscard) and its `sequence_events`
 * row in the SAME `db.batch()` (see {@link buildEventInsert}), so the change and
 * its activity entry are atomic.
 *
 * See docs/architecture/scene-shot-frame-redesign.md.
 */

import type { Database } from '@/lib/db/client';
import { framePromptVersions, frameVariants, frames } from '@/lib/db/schema';
import type { FrameVariant, NewFrameVariant } from '@/lib/db/schema';
import type { FrameVariantKind } from '@/lib/db/schema/frame-variants';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { buildFrameImageMirror, type CompletedFrameVariant } from './frames';
import { buildEventInsert } from './sequence-events';

/**
 * An image `FrameVariant` plus the id of the shot whose anchor frame owns it.
 * Frame ids are NOT shot ids (#989), so sequence-wide listings that the client
 * keys by shot (coverage markers, per-shot variant filtering) carry the owning
 * `shotId` explicitly rather than reusing `frameId`.
 */
export type ImageVariantWithShot = FrameVariant & { shotId: string };

/** The grouping key that makes a flat row set read as a "variant". */
type VariantGroup = {
  frameId: string;
  kind: FrameVariantKind;
  model: string;
  /** Only for `kind: 'framing'` rows — the model image the 3×3 came from. */
  sourceVariantId?: string | null;
};

export function createFrameVariantsMethods(db: Database) {
  return {
    getById: async (versionId: string): Promise<FrameVariant | null> => {
      const result = await db
        .select()
        .from(frameVariants)
        .where(eq(frameVariants.id, versionId));
      return result[0] ?? null;
    },

    /**
     * Append a new version row. Pure append — even when the inputs match an
     * existing version (a deliberate re-roll), a fresh row is created so the
     * history accumulates.
     *
     * The ONE exception is an in-flight append (`status: 'generating'` with a
     * `workflowRunId`): these are written inside multi-write workflow steps
     * (image `set-generating-status`, upscale `upscale-image`), so a Cloudflare
     * step retry after a partial failure would otherwise append a SECOND
     * orphan 'generating' row for the same run. We make that idempotent on
     * `(frameId, workflowRunId)` — re-rolls are unaffected because each carries
     * a fresh `workflowRunId`; only a retry of the same run reuses its row.
     */
    appendVersion: async (data: NewFrameVariant): Promise<FrameVariant> => {
      if (data.status === 'generating' && data.workflowRunId) {
        const [existing] = await db
          .select()
          .from(frameVariants)
          .where(
            and(
              eq(frameVariants.frameId, data.frameId),
              eq(frameVariants.workflowRunId, data.workflowRunId),
              eq(frameVariants.status, 'generating')
            )
          );
        if (existing) return existing;
      }
      const [version] = await db.insert(frameVariants).values(data).returning();
      if (!version) {
        throw new Error(
          `Failed to append frame variant for frame ${data.frameId}`
        );
      }
      return version;
    },

    /**
     * Mark any still-'generating' version for a workflow run as failed. Used by
     * the image workflow's `onFailure`, which only has the run id (not the
     * version id minted in the generating step).
     */
    markFailedByWorkflowRun: async (
      workflowRunId: string,
      error: string
    ): Promise<void> => {
      await db
        .update(frameVariants)
        .set({ status: 'failed', error, updatedAt: new Date() })
        .where(
          and(
            eq(frameVariants.workflowRunId, workflowRunId),
            eq(frameVariants.status, 'generating')
          )
        );
    },

    /** Update generation tracking on an in-flight version (status/url/error/…). */
    update: async (
      versionId: string,
      data: Partial<NewFrameVariant>
    ): Promise<FrameVariant> => {
      const [version] = await db
        .update(frameVariants)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(frameVariants.id, versionId))
        .returning();
      if (!version) {
        throw new Error(`FrameVariant ${versionId} not found`);
      }
      return version;
    },

    /**
     * The versions of one variant group, oldest-first so a per-model ordinal
     * label ("v1, v2, …") derives from position. Discarded rows are excluded
     * unless `includeDiscarded`.
     */
    listByGroup: async (
      group: VariantGroup,
      options?: { includeDiscarded?: boolean }
    ): Promise<FrameVariant[]> => {
      const conditions = [
        eq(frameVariants.frameId, group.frameId),
        eq(frameVariants.kind, group.kind),
        eq(frameVariants.model, group.model),
      ];
      // sourceVariantId distinguishes framing groups; match null explicitly so
      // model groups (null source) don't collide with framing picks.
      conditions.push(
        group.sourceVariantId == null
          ? isNull(frameVariants.sourceVariantId)
          : eq(frameVariants.sourceVariantId, group.sourceVariantId)
      );
      if (!options?.includeDiscarded) {
        conditions.push(isNull(frameVariants.discardedAt));
      }
      return await db
        .select()
        .from(frameVariants)
        .where(and(...conditions))
        .orderBy(asc(frameVariants.id));
    },

    /**
     * All `kind:'model'` versions across a sequence, oldest-first (excludes
     * discarded). The image analog of the retired `shotVariants.listBySequence`
     * — the coverage UI reduces these to latest-per-(frameId, model). frameId
     * == the shot's id, so existing shot-keyed client logic keeps working.
     */
    listModelVersionsBySequence: async (
      sequenceId: string
    ): Promise<ImageVariantWithShot[]> => {
      // Join the owning frame to surface its `shotId` — the client keys image
      // coverage / per-shot filtering by shot, and frame ids ≠ shot ids (#989).
      const rows = await db
        .select({ variant: frameVariants, shotId: frames.shotId })
        .from(frameVariants)
        .innerJoin(frames, eq(frames.id, frameVariants.frameId))
        .where(
          and(
            eq(frameVariants.sequenceId, sequenceId),
            eq(frameVariants.kind, 'model'),
            isNull(frameVariants.discardedAt)
          )
        )
        .orderBy(asc(frameVariants.id));
      return rows.map((r) => ({ ...r.variant, shotId: r.shotId }));
    },

    /** Distinct `kind:'model'` model names that have a version in a sequence. */
    listModelsForSequence: async (sequenceId: string): Promise<string[]> => {
      const rows = await db
        .selectDistinct({ model: frameVariants.model })
        .from(frameVariants)
        .where(
          and(
            eq(frameVariants.sequenceId, sequenceId),
            eq(frameVariants.kind, 'model'),
            isNull(frameVariants.discardedAt)
          )
        );
      return rows.map((r) => r.model);
    },

    /** All versions for a frame, oldest-first. Excludes discarded by default. */
    listByFrame: async (
      frameId: string,
      options?: { includeDiscarded?: boolean }
    ): Promise<FrameVariant[]> => {
      const conditions = [eq(frameVariants.frameId, frameId)];
      if (!options?.includeDiscarded) {
        conditions.push(isNull(frameVariants.discardedAt));
      }
      return await db
        .select()
        .from(frameVariants)
        .where(and(...conditions))
        .orderBy(asc(frameVariants.id));
    },

    /**
     * The current 3×3 grid SHEET for a frame: the latest `kind:'framing'`
     * version with no `sourceVariantId` (the raw sheet — a chosen tile points
     * its `sourceVariantId` at the sheet it was cropped from). Drives the
     * picker's `variantImageUrl`. Returns null when no grid has been generated.
     */
    getLatestGridSheet: async (
      frameId: string
    ): Promise<FrameVariant | null> => {
      const rows = await db
        .select()
        .from(frameVariants)
        .where(
          and(
            eq(frameVariants.frameId, frameId),
            eq(frameVariants.kind, 'framing'),
            isNull(frameVariants.sourceVariantId),
            isNull(frameVariants.discardedAt)
          )
        )
        .orderBy(desc(frameVariants.id))
        .limit(1);
      return rows[0] ?? null;
    },

    /**
     * Batch of the latest grid sheet per frame across a sequence (for list
     * projection). Returns a Map keyed by frameId; frames with no grid are
     * absent. One query, reduced to newest-per-frame in app code.
     */
    listLatestGridSheetsBySequence: async (
      sequenceId: string
    ): Promise<Map<string, FrameVariant>> => {
      const rows = await db
        .select()
        .from(frameVariants)
        .where(
          and(
            eq(frameVariants.sequenceId, sequenceId),
            eq(frameVariants.kind, 'framing'),
            isNull(frameVariants.sourceVariantId),
            isNull(frameVariants.discardedAt)
          )
        )
        .orderBy(asc(frameVariants.id));
      // asc by id (≈ time) → last write per frame wins.
      const byFrame = new Map<string, FrameVariant>();
      for (const row of rows) byFrame.set(row.frameId, row);
      return byFrame;
    },

    /**
     * The model of each shot's SELECTED image version across a sequence, keyed
     * by the owning shot (#1066). Model identity lives on the version row that
     * produced the bytes, so this is what generate/display resolve from — see
     * `@/lib/ai/resolve-asset-models`. One join, so the batch read paths
     * (smart retry, the editor's model bar) don't go N+1. Shots whose anchor
     * frame has no selection are absent; the caller falls back a tier.
     *
     * Anchors only (`orderIndex 0`) — the same frame the shot's still surface
     * projects from — so a shot's later frames can't collide on the shot key.
     *
     * Discarded versions are excluded, matching every sibling read here: a
     * discarded version is hidden from the variant strip, so resolving from it
     * would show a model the user can no longer see.
     */
    listSelectedModelsBySequence: async (
      sequenceId: string
    ): Promise<Map<string, string>> => {
      const rows = await db
        .select({ shotId: frames.shotId, model: frameVariants.model })
        .from(frames)
        .innerJoin(
          frameVariants,
          eq(frameVariants.id, frames.selectedImageVersionId)
        )
        .where(
          and(
            eq(frames.sequenceId, sequenceId),
            eq(frames.orderIndex, 0),
            isNull(frameVariants.discardedAt)
          )
        );
      return new Map(rows.map((r) => [r.shotId, r.model]));
    },

    /**
     * The `model` of each shot's newest FAILED image version, keyed by the
     * owning shot (#1066). A shot in a failed state is mid-attempt: this is the
     * model the user actually asked for, and it outranks the (older, still
     * selected) successful version when resolving a retry — otherwise a retry
     * silently re-runs the previous model. Anchors only, like the sibling above.
     */
    listLastFailedModelsBySequence: async (
      sequenceId: string
    ): Promise<Map<string, string>> => {
      const rows = await db
        .select({
          shotId: frames.shotId,
          model: frameVariants.model,
          versionId: frameVariants.id,
        })
        .from(frames)
        .innerJoin(frameVariants, eq(frameVariants.frameId, frames.id))
        .where(
          and(
            eq(frames.sequenceId, sequenceId),
            eq(frames.orderIndex, 0),
            eq(frameVariants.kind, 'model'),
            eq(frameVariants.status, 'failed'),
            isNull(frameVariants.discardedAt)
          )
        )
        .orderBy(asc(frameVariants.id));
      // asc by id (≈ time) → last write per shot wins.
      const byShot = new Map<string, string>();
      for (const row of rows) byShot.set(row.shotId, row.model);
      return byShot;
    },

    /**
     * The version the frame currently points at, or null if unset, dangling, or
     * discarded (see {@link listSelectedModelsBySequence} for why discarded is
     * excluded).
     */
    getSelected: async (frameId: string): Promise<FrameVariant | null> => {
      const [frame] = await db
        .select({ selected: frames.selectedImageVersionId })
        .from(frames)
        .where(eq(frames.id, frameId));
      if (!frame?.selected) return null;
      const [version] = await db
        .select()
        .from(frameVariants)
        .where(
          and(
            eq(frameVariants.id, frame.selected),
            isNull(frameVariants.discardedAt)
          )
        );
      return version ?? null;
    },

    /**
     * The newest FAILED version for a frame, or null. The single-shot analog of
     * {@link listLastFailedModelsBySequence}.
     */
    getLastFailed: async (frameId: string): Promise<FrameVariant | null> => {
      const rows = await db
        .select()
        .from(frameVariants)
        .where(
          and(
            eq(frameVariants.frameId, frameId),
            eq(frameVariants.kind, 'model'),
            eq(frameVariants.status, 'failed'),
            isNull(frameVariants.discardedAt)
          )
        )
        .orderBy(desc(frameVariants.id))
        .limit(1);
      return rows[0] ?? null;
    },

    /**
     * Repoint the frame's selection at `versionId`: set
     * `frames.selectedImageVersionId`, mirror the version's image fields onto
     * the frame, and append an `image.selected` activity event — all in one
     * `db.batch()` so the pointer move and its event are atomic. The event's
     * `data` carries the previous pointer so the change is undoable.
     *
     * When the version carries a `promptVersionId` (#1070), also repoint
     * `frames.selectedImagePromptVersionId` and mirror that prompt's text/hash
     * so the still and the prompt that produced it stay paired. Missing /
     * cross-frame prompt rows are skipped (legacy gens have null). Returns the
     * selected image version.
     */
    select: async (
      frameId: string,
      versionId: string,
      opts: { actorId: string | null }
    ): Promise<FrameVariant> => {
      const [version] = await db
        .select()
        .from(frameVariants)
        .where(
          and(
            eq(frameVariants.id, versionId),
            eq(frameVariants.frameId, frameId)
          )
        );
      if (!version) {
        throw new Error(
          `FrameVariant ${versionId} not found for frame ${frameId}`
        );
      }
      // Only a finished image may become the frame's primary still. Selecting a
      // pending/failed version would mirror its null url + failed status onto
      // the frame, silently blanking a good image.
      if (version.status !== 'completed') {
        throw new Error(
          `FrameVariant ${versionId} is '${version.status}', not 'completed' — cannot select an unfinished image`
        );
      }
      // `version` is a single object type, so the guard above narrows reads of
      // `version.status` but not `version` as a whole — re-affirm the completed
      // status in a typed local so the mirror builder's precondition is met
      // without an unsafe assertion.
      const completedVersion: CompletedFrameVariant = {
        ...version,
        status: 'completed',
      };
      const mirrorUpdate = buildFrameImageMirror(db, frameId, completedVersion);

      const [frame] = await db
        .select({
          sequenceId: frames.sequenceId,
          prev: frames.selectedImageVersionId,
          prevPromptVersionId: frames.selectedImagePromptVersionId,
        })
        .from(frames)
        .where(eq(frames.id, frameId));
      if (!frame) {
        throw new Error(`Frame ${frameId} not found`);
      }

      // Resolve the prompt that was live when this still was generated, if any.
      // Soft pointer — the row may have been pruned or never recorded.
      let linkedPrompt: {
        id: string;
        text: string;
        inputHash: string | null;
      } | null = null;
      if (version.promptVersionId) {
        const [promptRow] = await db
          .select({
            id: framePromptVersions.id,
            text: framePromptVersions.text,
            inputHash: framePromptVersions.inputHash,
            frameId: framePromptVersions.frameId,
          })
          .from(framePromptVersions)
          .where(eq(framePromptVersions.id, version.promptVersionId));
        if (promptRow && promptRow.frameId === frameId) {
          linkedPrompt = promptRow;
        }
      }

      const imageSelectedEvent = buildEventInsert(db, {
        sequenceId: frame.sequenceId,
        actorId: opts.actorId,
        kind: 'image.selected',
        targetType: 'frame',
        targetId: frameId,
        summary: `Selected ${version.model} image`,
        data: {
          versionId,
          model: version.model,
          prevVersionId: frame.prev ?? null,
          promptVersionId: linkedPrompt?.id ?? null,
          prevPromptVersionId: frame.prevPromptVersionId ?? null,
        },
      });

      if (linkedPrompt) {
        // One atomic batch: still mirror + image event + prompt mirror + prompt
        // event, so a history select never leaves the still and its text split.
        await db.batch([
          mirrorUpdate,
          imageSelectedEvent,
          db
            .update(frames)
            .set({
              imagePrompt: linkedPrompt.text,
              visualPromptInputHash: linkedPrompt.inputHash,
              selectedImagePromptVersionId: linkedPrompt.id,
              updatedAt: new Date(),
            })
            .where(eq(frames.id, frameId)),
          buildEventInsert(db, {
            sequenceId: frame.sequenceId,
            actorId: opts.actorId,
            kind: 'prompt.selected',
            targetType: 'frame',
            targetId: frameId,
            summary: 'Restored image prompt with selected still',
            data: {
              versionId: linkedPrompt.id,
              prevVersionId: frame.prevPromptVersionId ?? null,
              fromImageVersionId: versionId,
            },
          }),
        ]);
      } else {
        await db.batch([mirrorUpdate, imageSelectedEvent]);
      }
      return version;
    },

    /**
     * Soft-hide a version (undoable). Commits the `discardedAt` write and an
     * `image.discarded` event in one batch. Returns the timestamp for an Undo.
     */
    discard: async (
      versionId: string,
      opts: { actorId: string | null }
    ): Promise<Date> => {
      const [version] = await db
        .select({ sequenceId: frameVariants.sequenceId })
        .from(frameVariants)
        .where(eq(frameVariants.id, versionId));
      if (!version) {
        throw new Error(`FrameVariant ${versionId} not found`);
      }
      const discardedAt = new Date();
      await db.batch([
        db
          .update(frameVariants)
          .set({ discardedAt, updatedAt: discardedAt })
          .where(eq(frameVariants.id, versionId)),
        buildEventInsert(db, {
          sequenceId: version.sequenceId,
          actorId: opts.actorId,
          kind: 'image.discarded',
          targetType: 'variant',
          targetId: versionId,
          data: { versionId },
        }),
      ]);
      return discardedAt;
    },

    /** Undo a discard (clears `discardedAt`), with a matching event. */
    undiscard: async (
      versionId: string,
      opts: { actorId: string | null }
    ): Promise<void> => {
      const [version] = await db
        .select({ sequenceId: frameVariants.sequenceId })
        .from(frameVariants)
        .where(eq(frameVariants.id, versionId));
      if (!version) {
        throw new Error(`FrameVariant ${versionId} not found`);
      }
      const now = new Date();
      await db.batch([
        db
          .update(frameVariants)
          .set({ discardedAt: null, updatedAt: now })
          .where(eq(frameVariants.id, versionId)),
        buildEventInsert(db, {
          sequenceId: version.sequenceId,
          actorId: opts.actorId,
          kind: 'image.undiscarded',
          targetType: 'variant',
          targetId: versionId,
          data: { versionId },
        }),
      ]);
    },

    /**
     * Staleness of a single version: stored `inputHash` vs a fresh hash. Null
     * stored hash (legacy / in-flight) is "unknown, not stale". Throws when the
     * version is missing. Mirrors `shotVariants.isStale`.
     */
    isStale: async (
      versionId: string,
      currentHash: string
    ): Promise<boolean> => {
      const result = await db
        .select({ hash: frameVariants.inputHash })
        .from(frameVariants)
        .where(eq(frameVariants.id, versionId));
      const row = result[0];
      if (!row) {
        throw new Error(`FrameVariant ${versionId} not found`);
      }
      const stored = row.hash;
      if (stored === null) return false;
      return currentHash !== stored;
    },

    deleteByFrame: async (frameId: string): Promise<number> => {
      const result = await db
        .delete(frameVariants)
        .where(eq(frameVariants.frameId, frameId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return result.rowsAffected ?? 0;
    },

    deleteBySequence: async (sequenceId: string): Promise<number> => {
      const result = await db
        .delete(frameVariants)
        .where(eq(frameVariants.sequenceId, sequenceId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return result.rowsAffected ?? 0;
    },
  };
}
