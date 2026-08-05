-- #1067 — a shot owns no video columns. The whole surface (url/path/model/hash
-- and status/error/run id) is projected from the segment's `video_variants`
-- rows; `is_primary` distinguishes a render seeking the primary slot from an
-- added-model one, which is the bit the shot columns were standing in for.
-- Existing rows default to primary: a historical variant-only FAILURE may
-- therefore read as a primary failure until its shot is re-rendered.
-- D1-safe: ADD/DROP COLUMN only, no table rebuild (#612).
ALTER TABLE `video_variants` ADD `is_primary` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `video_url`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `video_path`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `video_status`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `video_workflow_run_id`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `video_generated_at`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `video_error`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `motion_model`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `video_input_hash`;