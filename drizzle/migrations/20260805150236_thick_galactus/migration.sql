-- #1067 — the last mirror. The image prompt lives on its version row; the
-- pointer `selected_image_prompt_version_id` is the only record. Backfilled by
-- 20260805132609 so no frame loses a prompt. DROP COLUMN only, no rebuild.
ALTER TABLE `frames` DROP COLUMN `image_prompt`;--> statement-breakpoint
ALTER TABLE `frames` DROP COLUMN `visual_prompt_input_hash`;