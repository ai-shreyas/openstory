/**
 * Shots Schema
 * Individual shots within a sequence
 */

import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  index,
  integer,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '../id';
import { renderSegments } from './render-segments';
import { scenes } from './scenes';
import { sequences } from './sequences';

export const SHOT_GENERATION_STATUSES = [
  'pending',
  'generating',
  'completed',
  'failed',
] as const;

/**
 * A shot is authoring intent plus pointers: it owns no assets and no scene
 * data. Scene context resolves through `sceneId`, the still through its anchor
 * frame, the video through `renderSegmentId`, the motion prompt through
 * `selectedMotionPromptVersionId`.
 */
// DB-Audit: `orderIndex` is sequence-global, so it re-encodes scene order and forces a renumber whenever a scene moves — derivable from (scenes.orderIndex, shotNumber).
export const shots = snakeCase.table(
  'shots',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    sequenceId: text()
      .notNull()
      .references(() => sequences.id, { onDelete: 'cascade' }),
    // No ON DELETE: `ALTER TABLE ADD COLUMN ... REFERENCES` cannot carry one,
    // so no database has ever had it. Deleting a scene with live shots errors;
    // callers null `sceneId` first. Declaring `set null` here would make
    // db:generate emit a `shots` REBUILD to add it — the #612 cascade trap.
    sceneId: text().references(() => scenes.id),
    // 1-based shot order within the scene. Backfill sets this to 1 (every
    // sequence becomes scenes-of-one-shot until multi-shot analysis lands).
    // DB-Audit: KEEP — considered for removal as derivable from `orderIndex`, but nothing enforces that a scene's shots stay contiguous, and a scene-scoped rank is what survives a scene reorder without renumbering every shot.
    shotNumber: integer(),
    // 0-based shot position within the SEQUENCE (not the scene) — the unique key `(sequence_id, order_index)` and the sort for every list query.
    // DB-Audit: drop once order is hierarchical — it re-encodes scene order, so it is derivable by ranking on `(scenes.orderIndex, shotNumber)`, and it forces a renumber of every later shot whenever a scene moves.
    // DB-Audit: blockers for that drop — re-key the upsert conflict target off `(sequence_id, order_index)`, re-sort every list query, and decide where orphaned shots sit (`sceneId` is nullable via ON DELETE set null).
    orderIndex: integer().notNull(),
    durationMs: integer().default(3000),
    // A shot owns no video columns (#1067 phase 2d). The whole surface —
    // url/path/model/hash AND status/error/run id — is projected from the
    // segment's `video_variants` rows by `projectShotWithImage`. Rendering is
    // segment-scoped, so shot-scoped video state could never be more than a
    // fan-out of one render's.
    // DB-Audit: drop after backfilling version rows for pre-#713 shots — mirror of the selected `shot_prompt_versions.text`, written only by `mirrorSelection` and read only as the legacy fallback when the pointer is null.
    motionPrompt: text(), // User-updated motion prompt (overrides AI-generated prompt from metadata)
    // Soft pointer (plain column, no FK — mirrors frames.selected*VersionId) to
    // the selected `shot_prompt_versions` row for the MOTION prompt. Selection
    // is a pointer, not a per-row flag: reverting / re-rolling the motion prompt
    // will repoint this. Additive groundwork in #988 — no write path populates
    // it yet (it stays null), so the repoint is wired in a later phase.
    selectedMotionPromptVersionId: text(),
    // The render segment this shot belongs to (#990) — a scene's video is tiled
    // into ≤cap segments (`render_segments`); per-shot rendering is the
    // degenerate one-shot segment. Membership lives here (order from
    // `orderIndex`); the segment owns the video selection pointer. NULL until
    // the shot is first rendered/assigned. Deliberately `set null` (not cascade)
    // so deleting a segment orphans its shots rather than vanishing them.
    renderSegmentId: text().references(() => renderSegments.id),
    // A shot owns no audio columns (#1067): per-shot audio was never built —
    // music is sequence-level (`sequences.music*`) and dialogue rides inside
    // the video.
    // SHA-256 of the upstream context that produced the cached motion prompt
    // (scene metadata + style config + character/location bible + analysis
    // model + starting-frame image). When upstream context changes, the prompt
    // itself is flagged stale independently of the rendered video. Null when no
    // AI prompt has been generated yet, or when the most recent version was a
    // user-edit (which has no upstream input surface). The visual (image) prompt
    // equivalent moved to `frames.visualPromptInputHash` in #989.
    // DB-Audit: drop with `motionPrompt` — mirror of `shot_prompt_versions.inputHash`, set in the same lockstep write.
    motionPromptInputHash: text(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    // Compound index for efficient ordering queries
    index('idx_shots_order').on(table.sequenceId, table.orderIndex),
    index('idx_shots_sequence_id').on(table.sequenceId),
    // Unique constraint: one shot per sequence/order combination
    uniqueIndex('shots_sequence_id_order_index_key').on(
      table.sequenceId,
      table.orderIndex
    ),
  ]
);

export type Shot = InferSelectModel<typeof shots>;
export type NewShot = InferInsertModel<typeof shots>;
