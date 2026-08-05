ALTER TABLE `sequence_exports` ADD `status` text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE `sequence_exports` ADD `error` text;--> statement-breakpoint
ALTER TABLE `sequence_exports` ADD `workflow_run_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_sequence_exports_one_processing` ON `sequence_exports` (`sequence_id`) WHERE "sequence_exports"."status" = 'processing';