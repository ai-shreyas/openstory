CREATE TABLE `scenes` (
	`id` text PRIMARY KEY,
	`sequence_id` text NOT NULL,
	`order_index` integer NOT NULL,
	`location` text,
	`time_of_day` text,
	`story_beat` text,
	`title` text,
	`continuity` text,
	`music_design` text,
	`original_script` text,
	`image_model` text(100),
	`video_model` text(100),
	`video_url` text,
	`video_path` text,
	`video_status` text DEFAULT 'pending',
	`video_workflow_run_id` text,
	`video_generated_at` integer,
	`video_error` text,
	`video_input_hash` text,
	`render_strategy` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_scenes_sequence_id_sequences_id_fk` FOREIGN KEY (`sequence_id`) REFERENCES `sequences`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `shots` ADD `scene_id` text REFERENCES scenes(id);--> statement-breakpoint
ALTER TABLE `shots` ADD `shot_number` integer;--> statement-breakpoint
CREATE INDEX `idx_scenes_sequence_order` ON `scenes` (`sequence_id`,`order_index`);--> statement-breakpoint
CREATE UNIQUE INDEX `scenes_sequence_id_order_index_key` ON `scenes` (`sequence_id`,`order_index`);--> statement-breakpoint
-- #907 backfill (1:1 expand): one scene per existing shot, splitting the
-- scene-level slices out of the shot's `metadata` (the Scene object). The scene
-- REUSES the shot's ULID as its id — shots↔scenes are 1:1 at this stage, so the
-- id is already a valid ULID and no app-side minting is needed (same rule as the
-- frames expand). Data DML, not a table rebuild: no DROP, no `__new_` shuffle,
-- so it sidesteps the D1/Turso ON DELETE CASCADE trap (CLAUDE.md / #612).
-- `WHERE scene_id IS NULL` keeps it safe to re-run. Touches only shots.scene_id
-- + shot_number, never `metadata` or any `*_input_hash`, so staleness is
-- unchanged. created_at/updated_at mirror the shot's.
INSERT INTO `scenes` (
	`id`, `sequence_id`, `order_index`,
	`location`, `time_of_day`, `story_beat`, `title`,
	`continuity`, `music_design`, `original_script`,
	`created_at`, `updated_at`
)
SELECT
	`id`, `sequence_id`, `order_index`,
	json_extract(`metadata`, '$.metadata.location'),
	json_extract(`metadata`, '$.metadata.timeOfDay'),
	json_extract(`metadata`, '$.metadata.storyBeat'),
	json_extract(`metadata`, '$.metadata.title'),
	json_extract(`metadata`, '$.continuity'),
	json_extract(`metadata`, '$.musicDesign'),
	json_extract(`metadata`, '$.originalScript'),
	`created_at`, `updated_at`
FROM `shots`
WHERE `scene_id` IS NULL;--> statement-breakpoint
UPDATE `shots` SET `scene_id` = `id`, `shot_number` = 1 WHERE `scene_id` IS NULL;