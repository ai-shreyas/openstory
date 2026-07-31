CREATE TABLE `model_pricing` (
	`provider` text(50) NOT NULL,
	`endpoint_id` text(200) NOT NULL,
	`unit` text(30) NOT NULL,
	`unit_price_micros` integer NOT NULL,
	`typical_units_per_call` real,
	`observed_median_units` real,
	`observed_sample_count` integer DEFAULT 0 NOT NULL,
	`fetched_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `model_pricing_pk` PRIMARY KEY(`provider`, `endpoint_id`, `unit`),
	CONSTRAINT "model_pricing_observed_pair" CHECK(("observed_median_units" IS NULL) = ("observed_sample_count" = 0))
);
--> statement-breakpoint
CREATE TABLE `model_pricing_history` (
	`id` text PRIMARY KEY,
	`provider` text(50) NOT NULL,
	`endpoint_id` text(200) NOT NULL,
	`unit` text(30) NOT NULL,
	`unit_price_micros` integer NOT NULL,
	`recorded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `model_usage_observations` (
	`id` text PRIMARY KEY,
	`provider` text(50) NOT NULL,
	`endpoint_id` text(200) NOT NULL,
	`units_billed` real NOT NULL,
	`num_images` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_model_pricing_history_endpoint` ON `model_pricing_history` (`provider`,`endpoint_id`,`recorded_at`);--> statement-breakpoint
CREATE INDEX `idx_model_usage_obs_endpoint_created` ON `model_usage_observations` (`provider`,`endpoint_id`,`created_at`);