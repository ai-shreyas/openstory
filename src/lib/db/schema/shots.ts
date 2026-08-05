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
 * - Motion/video content (videoUrl) + audio; the still IMAGE surface moved to
 *   `frames` in #989 (a shot is the VIDEO unit, a frame is the IMAGE unit).
 * - Scene data in metadata field (populated progressively across 5 phases)
 * - Generation tracking information
 *
 * @see src/lib/ai/scene-analysis.schema.ts for Scene structure
 */
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
    shotNumber: integer(),
    orderIndex: integer().notNull(),
    description: text(),
    durationMs: integer().default(3000),
    videoUrl: text(),
    videoPath: text(), // R2 storage path (not signed URL)
    // Video/motion generation status tracking
    videoStatus: text().$type<ShotGenerationStatus>().default('pending'),
    videoWorkflowRunId: text(),
    videoGeneratedAt: integer({
      mode: 'timestamp',
    }),
    videoError: text(),
    motionPrompt: text(), // User-updated motion prompt (overrides AI-generated prompt from metadata)
    // Soft pointer (plain column, no FK — mirrors frames.selected*VersionId) to
    // the selected `shot_prompt_versions` row for the MOTION prompt. Selection
    // is a pointer, not a per-row flag: reverting / re-rolling the motion prompt
    // will repoint this. Additive groundwork in #988 — no write path populates
    // it yet (it stays null), so the repoint is wired in a later phase.
    selectedMotionPromptVersionId: text(),
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
    // Audio/music generation status tracking
    audioUrl: text(),
    audioPath: text(), // R2 storage path (not signed URL)
    audioStatus: text().$type<ShotGenerationStatus>().default('pending'),
    audioWorkflowRunId: text(),
    audioGeneratedAt: integer({
      mode: 'timestamp',
    }),
    audioError: text(),
    audioModel: text({ length: 100 }), // Model used for music/audio generation (nullable)
    // SHA-256 of the inputs that produced each artifact; null when the
    // artifact has never been generated. See
    // docs/architecture/workflow-snapshots-and-content-hash-staleness.md.
    videoInputHash: text(),
    audioInputHash: text(),
    // SHA-256 of the upstream context that produced the cached motion prompt
    // (scene metadata + style config + character/location bible + analysis
    // model + starting-frame image). When upstream context changes, the prompt
    // itself is flagged stale independently of the rendered video. Null when no
    // AI prompt has been generated yet, or when the most recent version was a
    // user-edit (which has no upstream input surface). The visual (image) prompt
    // equivalent moved to `frames.visualPromptInputHash` in #989.
    motionPromptInputHash: text(),
    /**
     * Stores Scene data at various stages of progressive analysis.
     * Fields are populated progressively across 5 phases.
     * @see src/lib/ai/scene-analysis.schema.ts for Scene structure
     */
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
