-- #1067 — give every frame carrying an `image_prompt` a version row to point
-- at, so the mirror can be dropped without losing a prompt.
--
-- The image side never had a read path for `selected_image_prompt_version_id`:
-- it was written and never queried, so `frames.image_prompt` IS the read path
-- rather than a mirror of one. `framePromptVersions.getSelected` now exists;
-- this makes the pointer resolvable for every frame that has a prompt.
--
-- Set-based, not correlated subqueries — those trip D1's remote CPU limit and
-- migrations apply BEFORE deploy, so a slow one freezes the deploy (#1019).
-- Idempotent on a deterministic, non-ULID-shaped id.
--
-- `source` must be one of ai-generated / user-edit / regenerated / restored;
-- SQLite does not enforce it, so a wrong literal here would reach production.

INSERT INTO `frame_prompt_versions` (
  `id`, `frame_id`, `text`, `source`, `input_hash`, `status`, `created_at`
)
SELECT
  'bfip_' || f.`id`,
  f.`id`,
  f.`image_prompt`,
  'ai-generated',
  f.`visual_prompt_input_hash`,
  'completed',
  f.`created_at`
FROM `frames` f
WHERE f.`image_prompt` IS NOT NULL
  AND f.`image_prompt` <> ''
  AND f.`selected_image_prompt_version_id` IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM `frame_prompt_versions` v
    WHERE v.`id` = 'bfip_' || f.`id`
  );
--> statement-breakpoint
UPDATE `frames`
SET `selected_image_prompt_version_id` = m.`version_id`
FROM (
  SELECT v.`frame_id` AS `frame_id`, v.`id` AS `version_id`
  FROM `frame_prompt_versions` v
  WHERE v.`id` LIKE 'bfip\_%' ESCAPE '\'
) AS m
WHERE m.`frame_id` = `frames`.`id`
  AND `frames`.`selected_image_prompt_version_id` IS NULL;
