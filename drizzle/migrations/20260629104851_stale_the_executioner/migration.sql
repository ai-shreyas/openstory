-- #991 SSF Phase 4 (folds in #713 server-side prompt resolution).
--
-- 1-2. Additive columns: the motion `shot_prompt_versions` row becomes the full
-- immutable MotionPrompt snapshot — `text` (fullPrompt) + `components` +
-- `parameters` already existed; `dialogue` + `audio` carry the structured
-- direction audio-capable video models append at render time. (ADD COLUMN — no
-- table rebuild, so no FK-cascade trap; CLAUDE.md / #612.)
ALTER TABLE `shot_prompt_versions` ADD `dialogue` text;--> statement-breakpoint
ALTER TABLE `shot_prompt_versions` ADD `audio` text;--> statement-breakpoint

-- 3. Backfill the motion selection pointer (mirrors #989 step 6 for frames).
-- `shots.selected_motion_prompt_version_id` was NEVER populated before this PR,
-- so resolution + the Phase-3 render manifest were ignoring the version table on
-- every pre-existing shot. Point each shot at its latest motion version so
-- #713's pointer-driven resolution takes effect on existing data.
--
-- Set-based, NOT a per-row correlated subquery (#1019): the original correlated
-- form ran one lookup per shot which — combined with step 4's unindexed scan —
-- blew D1's remote CPU-time limit on production-sized data, rolling the whole
-- migration back and freezing the deploy pipeline. A single windowed pass over
-- `shot_prompt_versions` (`latest`), joined to `shots` by its primary key, stays
-- linear at any table size. Guarded `IS NULL` so it is safe to re-run; the
-- `latest` subquery only contains shots that have a motion version, so it
-- inherently skips shots without one.
UPDATE `shots`
SET `selected_motion_prompt_version_id` = `latest`.`version_id`
FROM (
	SELECT `shot_id`, `id` AS `version_id`
	FROM (
		SELECT
			`shot_id`,
			`id`,
			ROW_NUMBER() OVER (
				PARTITION BY `shot_id`
				ORDER BY `created_at` DESC, `id` DESC
			) AS `rn`
		FROM `shot_prompt_versions`
		WHERE `prompt_type` = 'motion'
	)
	WHERE `rn` = 1
) AS `latest`
WHERE `shots`.`id` = `latest`.`shot_id`
	AND `shots`.`selected_motion_prompt_version_id` IS NULL;--> statement-breakpoint

-- 4. Hydrate `dialogue` + `audio` on the now-selected motion version from the
-- shot's legacy `metadata.prompts.motion` (frame.metadata IS the Scene; the old
-- workflow wrote the structured prompt there). Restricted to the selected row
-- (what resolution reads) and only where both are still null, so it never
-- clobbers rows written by the new code path. `json_valid` guards malformed
-- metadata; `json_extract` of the nested object returns well-formed JSON text
-- that round-trips through the `text({mode:'json'})` column.
--
-- Set-based join, NOT correlated subqueries (#1019): the original form ran three
-- correlated subqueries per motion row, each a full scan of `shots` (there is no
-- index on `shots.selected_motion_prompt_version_id`), i.e. O(motion_rows x
-- shots) — ~10M row reads on production, which tripped D1's remote CPU-time
-- limit and aborted the deploy. Driving the join from `shots` and matching the
-- target `shot_prompt_versions` by its primary key (verified via EXPLAIN QUERY
-- PLAN: `SCAN shots` + `SEARCH spv USING INDEX (id=?)`) is linear.
UPDATE `shot_prompt_versions`
SET
	`dialogue` = json_extract(`s`.`metadata`, '$.prompts.motion.dialogue'),
	`audio` = json_extract(`s`.`metadata`, '$.prompts.motion.audio')
FROM `shots` `s`
WHERE `s`.`selected_motion_prompt_version_id` = `shot_prompt_versions`.`id`
	AND `shot_prompt_versions`.`prompt_type` = 'motion'
	AND `shot_prompt_versions`.`dialogue` IS NULL
	AND `shot_prompt_versions`.`audio` IS NULL
	AND json_valid(`s`.`metadata`)
	AND json_extract(`s`.`metadata`, '$.prompts.motion') IS NOT NULL;
