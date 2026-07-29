CREATE TABLE `model_usage_observations` (
	`id` text PRIMARY KEY,
	`provider` text(50) NOT NULL,
	`endpoint_id` text(200) NOT NULL,
	`units_billed` real NOT NULL,
	`num_images` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_model_usage_obs_endpoint_created` ON `model_usage_observations` (`provider`,`endpoint_id`,`created_at`);