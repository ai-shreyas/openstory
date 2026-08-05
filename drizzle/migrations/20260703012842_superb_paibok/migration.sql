CREATE TABLE `scene_script_versions` (
	`id` text PRIMARY KEY,
	`scene_id` text NOT NULL,
	`content` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text,
	CONSTRAINT `fk_scene_script_versions_scene_id_scenes_id_fk` FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_scene_script_versions_created_by_user_id_fk` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
ALTER TABLE `scenes` ADD `selected_script_version_id` text;--> statement-breakpoint
CREATE INDEX `idx_scene_script_versions_scene_created` ON `scene_script_versions` (`scene_id`,`created_at`);--> statement-breakpoint
-- #1030 backfill: seed one `split` version per scene. Reuse the scene id as the
-- initial version id (exactly one row per scene at backfill time). Content from
-- `scenes.original_script`, falling back to the first linked shot's metadata
-- slice. CREATE + DML only — no table rebuild (CLAUDE.md / #612). Set-based
-- joins only — no per-row correlated subqueries (#1019).
INSERT INTO `scene_script_versions` (
	`id`, `scene_id`, `content`, `source`, `created_at`
)
SELECT
	s.`id`,
	s.`id`,
	COALESCE(s.`original_script`, first_shot.`original_script`),
	'split',
	s.`created_at`
FROM `scenes` s
LEFT JOIN (
	SELECT
		`scene_id`,
		json_extract(`metadata`, '$.originalScript') AS `original_script`
	FROM (
		SELECT
			`scene_id`,
			`metadata`,
			ROW_NUMBER() OVER (
				PARTITION BY `scene_id`
				ORDER BY `shot_number` ASC, `order_index` ASC
			) AS `rn`
		FROM `shots`
		WHERE `scene_id` IS NOT NULL
	)
	WHERE `rn` = 1
) AS first_shot ON first_shot.`scene_id` = s.`id`
LEFT JOIN `scene_script_versions` ssv ON ssv.`scene_id` = s.`id`
WHERE COALESCE(s.`original_script`, first_shot.`original_script`) IS NOT NULL
	AND ssv.`id` IS NULL;--> statement-breakpoint
UPDATE `scenes`
SET `selected_script_version_id` = ssv.`id`
FROM `scene_script_versions` ssv
WHERE `scenes`.`id` = ssv.`scene_id`
	AND `scenes`.`selected_script_version_id` IS NULL;