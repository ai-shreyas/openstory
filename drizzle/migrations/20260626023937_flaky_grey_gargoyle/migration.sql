ALTER TABLE `sequence_music_prompt_variants` RENAME TO `sequence_music_prompt_versions`;--> statement-breakpoint
ALTER TABLE `shot_prompt_variants` RENAME TO `shot_prompt_versions`;--> statement-breakpoint
ALTER TABLE `shots` ADD `selected_motion_prompt_version_id` text;