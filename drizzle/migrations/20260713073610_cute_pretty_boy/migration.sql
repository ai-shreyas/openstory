CREATE TABLE `generated_assets` (
	`id` text PRIMARY KEY,
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`provider` text(50) NOT NULL,
	`endpoint_id` text(200) NOT NULL,
	`activity` text(20) NOT NULL,
	`model_name` text(200) NOT NULL,
	`input` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`outputs` text,
	`error` text,
	`workflow_run_id` text,
	`cost_micros` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_generated_assets_team_id_teams_id_fk` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_generated_assets_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX `idx_generated_assets_team` ON `generated_assets` (`team_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_generated_assets_team_endpoint` ON `generated_assets` (`team_id`,`endpoint_id`,`id`);