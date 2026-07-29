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
	CONSTRAINT `model_pricing_pk` PRIMARY KEY(`provider`, `endpoint_id`, `unit`)
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
CREATE INDEX `idx_model_pricing_history_endpoint` ON `model_pricing_history` (`provider`,`endpoint_id`,`recorded_at`);