-- #1067 — give every shot carrying a `motion_prompt` a version row to point at,
-- so the mirror columns can be dropped without losing a prompt.
--
-- Shots whose last motion prompt predates `mirrorSelection` have text in
-- `motion_prompt` and a NULL `selected_motion_prompt_version_id`. Reads fall
-- back to the mirror today; once it is gone they would resolve to an empty
-- prompt, which submits a blank render rather than failing.
--
-- Set-based, not correlated subqueries — those trip D1's remote CPU limit and
-- migrations apply BEFORE deploy, so a slow one freezes the deploy (#1019).
-- Idempotent: the INSERT skips shots that already have a backfilled row, and
-- the UPDATE only touches NULL pointers.

INSERT INTO `shot_prompt_versions` (
  `id`, `shot_id`, `prompt_type`, `text`, `source`, `input_hash`,
  `status`, `created_at`
)
SELECT
  -- Deterministic and not ULID-shaped, so it cannot collide with a real id.
  'bfmp_' || s.`id`,
  s.`id`,
  'motion',
  s.`motion_prompt`,
  'ai-generated',
  s.`motion_prompt_input_hash`,
  'completed',
  s.`created_at`
FROM `shots` s
WHERE s.`motion_prompt` IS NOT NULL
  AND s.`motion_prompt` <> ''
  AND s.`selected_motion_prompt_version_id` IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM `shot_prompt_versions` v
    WHERE v.`id` = 'bfmp_' || s.`id`
  );
--> statement-breakpoint
UPDATE `shots`
SET `selected_motion_prompt_version_id` = m.`version_id`
FROM (
  SELECT v.`shot_id` AS `shot_id`, v.`id` AS `version_id`
  FROM `shot_prompt_versions` v
  WHERE v.`id` LIKE 'bfmp\_%' ESCAPE '\' AND v.`prompt_type` = 'motion'
) AS m
WHERE m.`shot_id` = `shots`.`id`
  AND `shots`.`selected_motion_prompt_version_id` IS NULL;
