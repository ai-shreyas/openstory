/**
 * Shot Prompt Versions Schema
 *
 * One row per revision of a shot's visual or motion prompt. The current
 * "active" prompt is mirrored on `shots.imagePrompt` / `shots.motionPrompt`
 * for read-path simplicity; this table stores the full revision history.
 *
 * Renamed from `shot_prompt_variants` in the Scene→Shot→Frame redesign (#988):
 * a prompt is a single authored input revised over time (a *version* history),
 * not a set of parallel alternatives (*variants*). End-state role is the MOTION
 * prompt — the image/visual prompt migrates to `frame_prompt_versions` as the
 * image surface moves onto frames (later phases); the `promptType` column stays
 * dual-purpose meanwhile.
 *
 * See docs/architecture/workflow-snapshots-and-content-hash-staleness.md
 * § prompt versioning and docs/architecture/scene-shot-frame-redesign.md.
 */

import type {
  MotionAudio,
  MotionDialogue,
  MotionPromptComponents,
  MotionPromptParameters,
  VisualPromptComponents,
} from '@/lib/ai/scene-analysis.schema';
import { type InferSelectModel, sql } from 'drizzle-orm';
import {
  index,
  integer,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '../id';
import { user } from './auth';
import type { PromptVersionStatus } from './frame-prompt-versions';
import { shots } from './shots';

/**
 * The shape of `components` depends on `promptType`:
 *   - `'visual'` rows store `VisualPromptComponents` (sceneDescription /
 *     subject / lighting / ...)
 *   - `'motion'` rows store `MotionPromptComponents` (cameraMovement /
 *     speed / ...)
 * User-edits without structured components persist `null`.
 */
export type ShotPromptVersionComponents =
  | VisualPromptComponents
  | MotionPromptComponents;

export const SHOT_PROMPT_TYPES = ['visual', 'motion'] as const;
export type ShotPromptType = (typeof SHOT_PROMPT_TYPES)[number];

const PROMPT_VARIANT_SOURCES = [
  'ai-generated',
  'user-edit',
  'regenerated',
  'restored',
] as const;
export type PromptVariantSource = (typeof PROMPT_VARIANT_SOURCES)[number];

export const shotPromptVersions = snakeCase.table(
  'shot_prompt_versions',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    shotId: text()
      .notNull()
      .references(() => shots.id, { onDelete: 'cascade' }),
    promptType: text().$type<ShotPromptType>().notNull(),

    // Full prompt text (mirrors the cached column on `shots`).
    text: text().notNull(),
    // Structured prompt components (when available — visual prompts split into
    // composition / lighting / etc.; user-edits may not have components).
    components: text({
      mode: 'json',
    }).$type<ShotPromptVersionComponents>(),
    // Motion-only: timing / speed / camera parameters. Visual rows store null.
    parameters: text({
      mode: 'json',
    }).$type<MotionPromptParameters>(),
    // Motion-only: the scene's dialogue lines, captured so audio-capable video
    // models can append them at render time (the model is chosen at render, not
    // prompt-gen, so the structured data must persist on the version — #713).
    // Null when no dialogue / for visual rows.
    dialogue: text({
      mode: 'json',
    }).$type<MotionDialogue>(),
    // Motion-only: ambient sound + sound-effect direction, same rationale as
    // `dialogue`. Null when no audio direction / for visual rows.
    audio: text({
      mode: 'json',
    }).$type<MotionAudio>(),

    source: text().$type<PromptVariantSource>().notNull(),

    // SHA-256 of the upstream context that produced an AI prompt; null for
    // user-edits since they have no upstream input surface.
    inputHash: text(),

    // Analysis model that produced the prompt (null for user-edits).
    analysisModel: text({ length: 100 }),

    // Lifecycle + in-flight claim + producing instance (#1085) — see
    // `frame_prompt_versions` for the full contract; identical semantics.
    status: text().$type<PromptVersionStatus>().notNull().default('completed'),
    pendingInputHash: text(),
    workflowRunId: text(),

    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    createdBy: text().references(() => user.id, {
      onDelete: 'set null',
    }),
  },
  // Index names intentionally keep the `*_variants_*` spelling: SQLite's
  // `ALTER TABLE … RENAME TO` carries a table's indexes across unchanged, so
  // renaming them here would force a needless DROP/CREATE INDEX pair on top of
  // the rename. Keep them as-is so the #988 migration is RENAME TO + ADD COLUMN
  // only (no rebuild).
  (table) => [
    index('idx_shot_prompt_variants_shot_type_created').on(
      table.shotId,
      table.promptType,
      table.createdAt
    ),
    // Idempotency: a workflow retry that re-emits the same AI prompt for the
    // same upstream context must not create a duplicate row. User-edits and
    // legacy rows have null `input_hash` and are excluded; `source = 'restored'`
    // is also excluded so a restore that carries forward an existing AI hash
    // still appends an audit row to history.
    uniqueIndex('uq_shot_prompt_variants_shot_type_hash_ai')
      .on(table.shotId, table.promptType, table.inputHash)
      .where(
        sql`${table.inputHash} IS NOT NULL AND ${table.source} != 'restored'`
      ),
    // At most ONE live claim per (shot, type, live-hash) (#1085) — see the
    // frame-side twin for the race this closes.
    uniqueIndex('uq_shot_prompt_versions_live_claim')
      .on(table.shotId, table.promptType, table.pendingInputHash)
      .where(
        sql`${table.pendingInputHash} IS NOT NULL AND ${table.status} IN ('pending', 'generating')`
      ),
  ]
);

export type ShotPromptVersion = InferSelectModel<typeof shotPromptVersions>;
