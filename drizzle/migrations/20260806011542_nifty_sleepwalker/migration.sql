-- #1067 — shot order becomes hierarchical; drop the sequence-global mirror.
--
-- `shots.order_index` was an exact copy of `scenes.order_index` reached through
-- the shot's own scene link: the split writes both from the same loop variable.
-- Verified against production before the drop — all 4334 shots satisfied
-- `shots.order_index = scenes.order_index`, `shot_number = 1`, zero rows with a
-- NULL `scene_id`, and zero duplicate `(scene_id, shot_number)` pairs.
--
-- It also carried a second job: `(sequence_id, order_index)` was the upsert
-- conflict target that makes a workflow replay hit the same shot row
-- (`dedup-ids.ts`). That moves to `(scene_id, shot_number)`, which the split
-- already knows at insert time.
--
-- The new unique index is PARTIAL so neither column needs NOT NULL — adding
-- that would force a `shots` table rebuild, and `frames`,
-- `shot_prompt_versions` and `shot_variants` all cascade off `shots` (#612).
-- DROP/CREATE INDEX and DROP COLUMN rebuild nothing.

DROP INDEX IF EXISTS `idx_shots_order`;--> statement-breakpoint
DROP INDEX IF EXISTS `shots_sequence_id_order_index_key`;--> statement-breakpoint
CREATE INDEX `idx_shots_scene_id` ON `shots` (`scene_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_shots_scene_shot_number` ON `shots` (`scene_id`,`shot_number`) WHERE "shots"."scene_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `order_index`;
