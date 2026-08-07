-- #1067 — the motion prompt lives on its version row, not on the shot.
-- Both columns mirrored the selected `shot_prompt_versions` row; the pointer
-- `selected_motion_prompt_version_id` is the only record now. Backfilled by
-- 20260805115709 so no shot loses a prompt. DROP COLUMN only, no rebuild.
ALTER TABLE `shots` DROP COLUMN `motion_prompt`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `motion_prompt_input_hash`;