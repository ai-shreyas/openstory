-- #989 SSF Phase 2 — migrate the IMAGE surface off `shots` onto `frames`.
--
-- Data-copy DML, NOT a table rebuild: the anchor frame REUSES its shot's ULID
-- (frame.id = shot.id), model versions REUSE their shot_variants ULID, and visual
-- prompt versions REUSE their shot_prompt_versions ULID — so no app-side id
-- minting is needed in SQL (the #907 scenes-split rule). Pure INSERT…SELECT /
-- UPDATE / DELETE: no DROP TABLE, no `__new_` shuffle, so it sidesteps the
-- D1/Turso ON DELETE CASCADE trap (CLAUDE.md / #612). Every step is guarded with
-- `WHERE NOT EXISTS` / `IS NULL` so the migration is safe to re-run.
--
-- All reads of the soon-to-be-dropped `shots` image columns + `shot_variants`
-- (image) happen in the INSERT/UPDATE steps below, BEFORE the DELETE cleanup and
-- the ALTER … DROP COLUMN at the end (copy-then-drop). `frames` is empty before
-- this (created empty in #987), so the copies fill it for the first time.

-- 1. Anchor frame (orderIndex 0, role 'first') per shot — the i2v anchor / the
--    shot's primary still. Mirrors the shot's thumbnail* + image* columns.
INSERT INTO `frames` (
	`id`, `shot_id`, `sequence_id`, `order_index`, `role`, `source`,
	`image_url`, `preview_image_url`, `image_path`, `image_status`,
	`image_workflow_run_id`, `image_generated_at`, `image_error`,
	`image_model`, `image_prompt`, `image_input_hash`, `visual_prompt_input_hash`,
	`created_at`, `updated_at`
)
SELECT
	`id`, `id`, `sequence_id`, 0, 'first', 'generated',
	`thumbnail_url`, `preview_thumbnail_url`, `thumbnail_path`,
	COALESCE(`thumbnail_status`, 'pending'),
	`thumbnail_workflow_run_id`, `thumbnail_generated_at`, `thumbnail_error`,
	`image_model`, `image_prompt`, `thumbnail_input_hash`, `visual_prompt_input_hash`,
	`created_at`, `updated_at`
FROM `shots`
WHERE NOT EXISTS (SELECT 1 FROM `frames` f WHERE f.`id` = `shots`.`id`);--> statement-breakpoint

-- 2. Model versions: every shot_variants image row becomes a flat
--    `kind='model'` frame_variants version (id reused). `diverged_at` is dropped
--    — divergent alternates simply become retained versions the user can select;
--    `discarded_at` carries over. frame_id = shot_id (== the anchor frame.id).
INSERT INTO `frame_variants` (
	`id`, `frame_id`, `sequence_id`, `kind`, `model`, `source_variant_id`,
	`url`, `storage_path`, `preview_url`, `status`, `workflow_run_id`,
	`generated_at`, `error`, `prompt_hash`, `input_hash`, `discarded_at`,
	`created_at`, `updated_at`
)
SELECT
	`id`, `shot_id`, `sequence_id`, 'model', `model`, NULL,
	`url`, `storage_path`, `preview_url`, `status`, `workflow_run_id`,
	`generated_at`, `error`, `prompt_hash`, `input_hash`, `discarded_at`,
	`created_at`, `updated_at`
FROM `shot_variants`
WHERE `variant_type` = 'image'
	AND NOT EXISTS (SELECT 1 FROM `frame_variants` fv WHERE fv.`id` = `shot_variants`.`id`);--> statement-breakpoint

-- 3. Synthetic primary version for shots that have a still but NO matching
--    primary `shot_variants` row (pre-#542 shots, or rows whose variant was
--    pruned). id = shot.id (a valid ULID; same cross-table id-share the anchor
--    frame already accepts) so the selection pointer below can target it.
INSERT INTO `frame_variants` (
	`id`, `frame_id`, `sequence_id`, `kind`, `model`, `source_variant_id`,
	`url`, `storage_path`, `preview_url`, `status`, `workflow_run_id`,
	`generated_at`, `error`, `prompt_hash`, `input_hash`, `discarded_at`,
	`created_at`, `updated_at`
)
SELECT
	`id`, `id`, `sequence_id`, 'model', `image_model`, NULL,
	`thumbnail_url`, `thumbnail_path`, `preview_thumbnail_url`,
	COALESCE(`thumbnail_status`, 'completed'), `thumbnail_workflow_run_id`,
	`thumbnail_generated_at`, `thumbnail_error`, NULL, `thumbnail_input_hash`, NULL,
	`created_at`, `updated_at`
FROM `shots`
WHERE `thumbnail_url` IS NOT NULL
	AND NOT EXISTS (
		SELECT 1 FROM `shot_variants` sv
		WHERE sv.`shot_id` = `shots`.`id`
			AND sv.`variant_type` = 'image'
			AND sv.`diverged_at` IS NULL
			AND sv.`model` = `shots`.`image_model`
	)
	AND NOT EXISTS (SELECT 1 FROM `frame_variants` fv WHERE fv.`id` = `shots`.`id`);--> statement-breakpoint

-- 4a. Selection pointer → the primary (non-divergent, completed) variant for the
--     shot's current model. Read `diverged_at` here while it still exists.
UPDATE `frames`
SET `selected_image_version_id` = (
	SELECT sv.`id` FROM `shot_variants` sv
	WHERE sv.`shot_id` = `frames`.`id`
		AND sv.`variant_type` = 'image'
		AND sv.`diverged_at` IS NULL
		AND sv.`status` = 'completed'
		AND sv.`model` = (SELECT s.`image_model` FROM `shots` s WHERE s.`id` = `frames`.`id`)
	LIMIT 1
)
WHERE `selected_image_version_id` IS NULL
	AND EXISTS (
		SELECT 1 FROM `shot_variants` sv
		WHERE sv.`shot_id` = `frames`.`id`
			AND sv.`variant_type` = 'image'
			AND sv.`diverged_at` IS NULL
			AND sv.`status` = 'completed'
			AND sv.`model` = (SELECT s.`image_model` FROM `shots` s WHERE s.`id` = `frames`.`id`)
	);--> statement-breakpoint

-- 4b. Fallback: point at the synthetic primary version (id = frame.id) created in
--     step 3 for shots that had no matching shot_variants row.
UPDATE `frames`
SET `selected_image_version_id` = `id`
WHERE `selected_image_version_id` IS NULL
	AND EXISTS (
		SELECT 1 FROM `frame_variants` fv
		WHERE fv.`id` = `frames`.`id` AND fv.`kind` = 'model'
	);--> statement-breakpoint

-- 5. Visual prompt history: shot_prompt_versions(visual) → frame_prompt_versions
--    (id reused). Motion prompt versions stay on shot_prompt_versions.
INSERT INTO `frame_prompt_versions` (
	`id`, `frame_id`, `text`, `components`, `source`, `input_hash`,
	`analysis_model`, `created_at`, `created_by`
)
SELECT
	`id`, `shot_id`, `text`, `components`, `source`, `input_hash`,
	`analysis_model`, `created_at`, `created_by`
FROM `shot_prompt_versions`
WHERE `prompt_type` = 'visual'
	AND NOT EXISTS (SELECT 1 FROM `frame_prompt_versions` fpv WHERE fpv.`id` = `shot_prompt_versions`.`id`);--> statement-breakpoint

-- 6. Selected prompt pointer → the latest visual prompt version per frame.
UPDATE `frames`
SET `selected_image_prompt_version_id` = (
	SELECT fpv.`id` FROM `frame_prompt_versions` fpv
	WHERE fpv.`frame_id` = `frames`.`id`
	ORDER BY fpv.`created_at` DESC, fpv.`id` DESC
	LIMIT 1
)
WHERE `selected_image_prompt_version_id` IS NULL
	AND EXISTS (SELECT 1 FROM `frame_prompt_versions` fpv WHERE fpv.`frame_id` = `frames`.`id`);--> statement-breakpoint

-- 7. Cleanup: drop the now-copied image rows from the legacy tables (gated by
--    --allow-destructive; copied immediately above). shot_variants keeps video;
--    shot_prompt_versions keeps motion. Neither has inbound cascades.
DELETE FROM `shot_variants` WHERE `variant_type` = 'image';--> statement-breakpoint
DELETE FROM `shot_prompt_versions` WHERE `prompt_type` = 'visual';--> statement-breakpoint

-- 8. Drop the migrated image columns off `shots` (ALTER … DROP COLUMN — no table
--    rebuild, so no FK-cascade trap). None are indexed, so no index drop needed.
ALTER TABLE `shots` DROP COLUMN `thumbnail_url`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `preview_thumbnail_url`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `thumbnail_path`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `variant_image_url`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `variant_image_status`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `variant_workflow_run_id`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `variant_image_generated_at`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `variant_image_error`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `thumbnail_status`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `thumbnail_workflow_run_id`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `thumbnail_generated_at`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `thumbnail_error`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `image_model`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `image_prompt`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `thumbnail_input_hash`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `variant_image_input_hash`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `visual_prompt_input_hash`;
