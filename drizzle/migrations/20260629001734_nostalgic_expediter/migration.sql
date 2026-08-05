CREATE TABLE `render_segments` (
	`id` text PRIMARY KEY,
	`scene_id` text NOT NULL,
	`sequence_id` text NOT NULL,
	`selected_video_version_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_render_segments_scene_id_scenes_id_fk` FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_render_segments_sequence_id_sequences_id_fk` FOREIGN KEY (`sequence_id`) REFERENCES `sequences`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `video_variants` (
	`id` text PRIMARY KEY,
	`render_segment_id` text NOT NULL,
	`sequence_id` text NOT NULL,
	`model` text(100) NOT NULL,
	`manifest` text NOT NULL,
	`url` text,
	`storage_path` text,
	`preview_url` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`workflow_run_id` text,
	`generated_at` integer,
	`error` text,
	`input_hash` text,
	`discarded_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_video_variants_render_segment_id_render_segments_id_fk` FOREIGN KEY (`render_segment_id`) REFERENCES `render_segments`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_video_variants_sequence_id_sequences_id_fk` FOREIGN KEY (`sequence_id`) REFERENCES `sequences`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `shots` ADD `render_segment_id` text REFERENCES render_segments(id);--> statement-breakpoint
CREATE INDEX `idx_render_segments_scene` ON `render_segments` (`scene_id`);--> statement-breakpoint
CREATE INDEX `idx_render_segments_sequence` ON `render_segments` (`sequence_id`);--> statement-breakpoint
CREATE INDEX `idx_video_variants_group` ON `video_variants` (`render_segment_id`,`model`);--> statement-breakpoint
CREATE INDEX `idx_video_variants_sequence` ON `video_variants` (`sequence_id`);--> statement-breakpoint
-- SSF Phase 3 (#990) backfill: move the video slice of `shot_variants` into the
-- relational Scene → Segment → Shot model. Pure DML INSERT/UPDATE (no table
-- rebuild, no FK-cascade trap — the #907/#989 pattern). Runs at the cutover,
-- capturing every video row regardless of when it was written.
--
-- 1) Materialize a degenerate per-shot render segment for every shot that has a
--    video variant. The segment REUSES the shot's id (like the #906 anchor frame)
--    — a deterministic key; resolution is always via shots.render_segment_id,
--    never by assuming id == shot_id.
INSERT INTO `render_segments` (`id`, `scene_id`, `sequence_id`, `selected_video_version_id`, `created_at`, `updated_at`)
SELECT DISTINCT s.`id`, s.`scene_id`, s.`sequence_id`, NULL, s.`created_at`, s.`updated_at`
FROM `shots` s
JOIN `shot_variants` sv ON sv.`shot_id` = s.`id` AND sv.`variant_type` = 'video'
WHERE s.`scene_id` IS NOT NULL;--> statement-breakpoint
-- 2) Link those shots to their (degenerate) segment.
UPDATE `shots` SET `render_segment_id` = `id`
WHERE `scene_id` IS NOT NULL
  AND EXISTS (SELECT 1 FROM `shot_variants` sv WHERE sv.`shot_id` = `shots`.`id` AND sv.`variant_type` = 'video');--> statement-breakpoint
-- 3) Copy the video versions (completed + divergent history, so the per-model
--    switcher keeps its alternates). The manifest references the shot's
--    currently-selected motion-prompt + anchor-frame image versions (null when
--    none — reference-driven). The primary per-shot video stays mirrored on
--    `shots.video*` (untouched); the segment's selection pointer stays NULL for
--    legacy rows and the next render/select repoints it.
INSERT INTO `video_variants` (
	`id`, `render_segment_id`, `sequence_id`, `model`, `manifest`,
	`input_hash`, `url`, `storage_path`, `preview_url`, `status`,
	`workflow_run_id`, `generated_at`, `error`, `discarded_at`, `created_at`, `updated_at`
)
SELECT
	sv.`id`, sv.`shot_id`, sv.`sequence_id`, sv.`model`,
	json_array(json_object(
		'shotId', sv.`shot_id`,
		'motionPromptVersionId', s.`selected_motion_prompt_version_id`,
		'frameVersionId', f.`selected_image_version_id`,
		'durationMs', COALESCE(sv.`duration_ms`, s.`duration_ms`, 0)
	)),
	sv.`input_hash`, sv.`url`, sv.`storage_path`, sv.`preview_url`, sv.`status`,
	sv.`workflow_run_id`, sv.`generated_at`, sv.`error`, sv.`discarded_at`, sv.`created_at`, sv.`updated_at`
FROM `shot_variants` sv
JOIN `shots` s ON s.`id` = sv.`shot_id`
LEFT JOIN `frames` f ON f.`shot_id` = sv.`shot_id` AND f.`role` = 'first' AND f.`order_index` = 0
WHERE sv.`variant_type` = 'video' AND s.`scene_id` IS NOT NULL;