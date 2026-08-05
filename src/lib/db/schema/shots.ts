/**
 * Shots Schema
 * Individual shots within a sequence
 */

import type { Scene } from '@/lib/ai/scene-analysis.schema';
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
type ShotGenerationStatus = (typeof SHOT_GENERATION_STATUSES)[number];

/**
 * Shots table
 * Individual shots within a sequence
 *
 * Each shot represents one scene from script analysis and stores:
 * - Motion/video content (videoUrl); the still IMAGE surface moved to
 *   `frames` in #989 (a shot is the VIDEO unit, a frame is the IMAGE unit).
 * - Scene data in metadata field (populated progressively across 5 phases)
 * - Generation tracking information
 *
 * @see src/lib/ai/scene-analysis.schema.ts for Scene structure
 */
// DB-Audit: ideal shape — a shot is authoring intent plus pointers. It owns no assets.
// DB-Audit: identity/placement — id, sequenceId, sceneId, and a hierarchical order: `scenes.orderIndex` for scene order, `shotNumber` for the shot's rank within its scene.
// DB-Audit: `orderIndex` is 0-based within the SEQUENCE, so it re-encodes scene order — a second stored ordering that can disagree with the first, and that forces a renumber whenever a scene moves.
// DB-Audit: authoring — durationMs, plus the shot-scoped framing/action/camera/sound fields once #910 emits them; a shot carries no scene metadata, it resolves scene context through `sceneId`.
// DB-Audit: `metadata` is the whole analysis `Scene` copied onto every shot, and every field read off it (continuity, durationSeconds, location, title, sceneId, originalScript, musicDesign) is scene-scoped and already lives on `scenes`.
// DB-Audit: membership — renderSegmentId; the segment owns the video selection, so the shot needs no video pointer of its own.
// DB-Audit: prompt — selectedMotionPromptVersionId → `shot_prompt_versions` (text, components, dialogue, audio, inputHash, analysisModel).
// DB-Audit: video — render_segments.selectedVideoVersionId → `video_variants` (url, storagePath, status, workflowRunId, generatedAt, error, model, inputHash).
// DB-Audit: therefore no asset, status, model, or artifact-hash column belongs on the shot — each one is already a field on the version row that produced it.
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
    // Parent scene (#907). NULL until backfilled. Deliberately NOT cascade —
    // CLAUDE.md rule 3: never cascade to long-lived parents; orphaned shots
    // null out rather than vanish if a scene is deleted.
    sceneId: text().references(() => scenes.id, { onDelete: 'set null' }),
    // 1-based shot order within the scene. Backfill sets this to 1 (every
    // sequence becomes scenes-of-one-shot until multi-shot analysis lands).
    // DB-Audit: KEEP — considered for removal as derivable from `orderIndex`, but nothing enforces that a scene's shots stay contiguous, and a scene-scoped rank is what survives a scene reorder without renumbering every shot.
    shotNumber: integer(),
    // 0-based shot position within the SEQUENCE (not the scene) — the unique key `(sequence_id, order_index)` and the sort for every list query.
    // DB-Audit: drop once order is hierarchical — it re-encodes scene order, so it is derivable by ranking on `(scenes.orderIndex, shotNumber)`, and it forces a renumber of every later shot whenever a scene moves.
    // DB-Audit: blockers for that drop — re-key the upsert conflict target off `(sequence_id, order_index)`, re-sort every list query, and decide where orphaned shots sit (`sceneId` is nullable via ON DELETE set null).
    orderIndex: integer().notNull(),
    // DB-Audit: drop once the prompt fallbacks read the scene script — this is the scene's `originalScript.extract` copied at split time, never regenerated, and only read as the last-resort prompt fallback and as `visualSummary` for music design.
    description: text(),
    durationMs: integer().default(3000),
    // DB-Audit: these eight video columns LOOK like a mirror of `video_variants` but in prod they are still the PRIMARY record for most rows.
    // DB-Audit: measured 2026-08-05 on openstory-prd — 3041 shots have video_url; 1041 have no render_segment_id at all, and 1887 more point at a segment whose selected_video_version_id is NULL (only 113 of 2074 segments carry a selection).
    // DB-Audit: the #990 cutover (20260629001734_nostalgic_expediter) deferred this on purpose — "the segment's selection pointer stays NULL for legacy rows and the next render/select repoints it".
    // DB-Audit: so re-routing reads through the segment pointer today would blank 2928 of 3041 videos. Backfill segments + selection to 3041/3041 FIRST, re-measure, and only then drop.
    // DB-Audit: NOT droppable yet — backfill first (see the block above); then it is a copy of `video_variants.url`, written by `buildShotVideoMirror`.
    videoUrl: text(),
    // DB-Audit: NOT droppable yet — backfill first (see the block above); then it is a copy of `video_variants.storagePath`.
    videoPath: text(), // R2 storage path (not signed URL)
    // Video/motion generation status tracking
    // DB-Audit: NOT droppable yet — backfill first (see the block above); then it is a copy of `video_variants.status`.
    videoStatus: text().$type<ShotGenerationStatus>().default('pending'),
    // DB-Audit: NOT droppable yet — backfill first (see the block above); then it is a copy of `video_variants.workflowRunId`.
    videoWorkflowRunId: text(),
    // DB-Audit: NOT droppable yet — backfill first (see the block above); then it is a copy of `video_variants.generatedAt`, and already write-only (nothing reads it today).
    videoGeneratedAt: integer({
      mode: 'timestamp',
    }),
    // DB-Audit: NOT droppable yet — backfill first (see the block above); then it is a copy of `video_variants.error`.
    videoError: text(),
    // DB-Audit: drop after backfilling version rows for pre-#713 shots — mirror of the selected `shot_prompt_versions.text`, written only by `mirrorSelection` and read only as the legacy fallback when the pointer is null.
    motionPrompt: text(), // User-updated motion prompt (overrides AI-generated prompt from metadata)
    // Soft pointer (plain column, no FK — mirrors frames.selected*VersionId) to
    // the selected `shot_prompt_versions` row for the MOTION prompt. Selection
    // is a pointer, not a per-row flag: reverting / re-rolling the motion prompt
    // will repoint this. Additive groundwork in #988 — no write path populates
    // it yet (it stays null), so the repoint is wired in a later phase.
    selectedMotionPromptVersionId: text(),
    // DB-Audit: NOT droppable yet — backfill first (see the block above); then it is a copy of `video_variants.model`; #1066 puts model identity on the version row and `resolve-asset-models` already forbids reading this.
    motionModel: text({ length: 100 }), // Model used for motion/video generation (nullable - inherits from sequence if not set)
    // The render segment this shot belongs to (#990) — a scene's video is tiled
    // into ≤cap segments (`render_segments`); per-shot rendering is the
    // degenerate one-shot segment. Membership lives here (order from
    // `orderIndex`); the segment owns the video selection pointer. NULL until
    // the shot is first rendered/assigned. Deliberately `set null` (not cascade)
    // so deleting a segment orphans its shots rather than vanishing them.
    renderSegmentId: text().references(() => renderSegments.id, {
      onDelete: 'set null',
    }),
    // A shot owns no audio columns (#1067): per-shot audio was never built —
    // music is sequence-level (`sequences.music*`) and dialogue rides inside
    // the video.
    // SHA-256 of the inputs that produced each artifact; null when the
    // artifact has never been generated. See
    // docs/architecture/workflow-snapshots-and-content-hash-staleness.md.
    // DB-Audit: NOT droppable yet — backfill first (see the block above); then it is a copy of `video_variants.inputHash`.
    videoInputHash: text(),
    // SHA-256 of the upstream context that produced the cached motion prompt
    // (scene metadata + style config + character/location bible + analysis
    // model + starting-frame image). When upstream context changes, the prompt
    // itself is flagged stale independently of the rendered video. Null when no
    // AI prompt has been generated yet, or when the most recent version was a
    // user-edit (which has no upstream input surface). The visual (image) prompt
    // equivalent moved to `frames.visualPromptInputHash` in #989.
    // DB-Audit: drop with `motionPrompt` — mirror of `shot_prompt_versions.inputHash`, set in the same lockstep write.
    motionPromptInputHash: text(),
    /**
     * Stores Scene data at various stages of progressive analysis.
     * Fields are populated progressively across 5 phases.
     * @see src/lib/ai/scene-analysis.schema.ts for Scene structure
     */
    // DB-Audit: drop — this is scene metadata on a shot; no read of it is shot-scoped, so scene context should resolve via `sceneId` → `scenes` and durationSeconds via `durationMs`.
    metadata: text({ mode: 'json' }).$type<Scene>(),
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

// Override the inferred Shot type to use Scene for metadata
type InferredShot = InferSelectModel<typeof shots>;
export type Shot = Omit<InferredShot, 'metadata'> & {
  metadata: Scene | null; // Nullable until script analysis completes, fields populate progressively
};

type InferredNewShot = InferInsertModel<typeof shots>;
export type NewShot = Omit<InferredNewShot, 'metadata'> & {
  metadata?: Scene | null; // Optional - can be null initially, populated during script analysis
};
