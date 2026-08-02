ALTER TABLE `frame_prompt_versions` ADD `status` text DEFAULT 'completed' NOT NULL;--> statement-breakpoint
ALTER TABLE `frame_prompt_versions` ADD `pending_input_hash` text;--> statement-breakpoint
ALTER TABLE `frame_prompt_versions` ADD `workflow_run_id` text;--> statement-breakpoint
ALTER TABLE `frame_variants` ADD `pending_input_hash` text;--> statement-breakpoint
ALTER TABLE `frame_variants` ADD `depends_on_version_id` text;--> statement-breakpoint
ALTER TABLE `shot_prompt_versions` ADD `status` text DEFAULT 'completed' NOT NULL;--> statement-breakpoint
ALTER TABLE `shot_prompt_versions` ADD `pending_input_hash` text;--> statement-breakpoint
ALTER TABLE `shot_prompt_versions` ADD `workflow_run_id` text;