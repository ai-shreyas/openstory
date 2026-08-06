-- #1067 — give every frame carrying an `image_prompt` a version row to point
-- at, so the mirror can be removed without losing a prompt.
--
-- The image side never had a read path for `selected_image_prompt_version_id`:
-- it was written and never queried, so `frames.image_prompt` IS the read path
-- rather than a mirror of one. `framePromptVersions.getSelected` now exists;
-- this makes the pointer resolvable for every frame that has a prompt.
--
-- The version row REUSES its frame's ULID, for the same reason the motion
-- backfill reuses its shot's: `ulidSchema` (26 chars, Crockford base32) guards
-- every path that takes a version id back from the client, so a prefixed
-- `bfip_<ulid>` would make Restore fail on exactly these rows. Reuse is safe —
-- at most one backfilled row per frame, and production has 0 frames whose id
-- already exists in `frame_prompt_versions` (1513 to backfill, 0 collisions).
--
-- NOTE: #989 gave an anchor frame its shot's id, so for 1383 of these the id
-- minted here EQUALS the one the motion backfill mints in
-- `shot_prompt_versions`. That is fine across two tables, but it is why
-- `restoreShotPromptVariantFn` dispatches on an explicit `promptType` rather
-- than probing which store holds the id.
--
-- Set-based, not correlated subqueries — those trip D1's remote CPU limit and
-- migrations apply BEFORE deploy, so a slow one freezes the deploy (#1019).
--
-- `source` must be one of ai-generated / user-edit / regenerated / restored;
-- SQLite does not enforce it, so a wrong literal here would reach production.

INSERT INTO `frame_prompt_versions` (
  `id`, `frame_id`, `text`, `source`, `input_hash`, `status`, `created_at`
)
SELECT
  f.`id`,
  f.`id`,
  f.`image_prompt`,
  'ai-generated',
  f.`visual_prompt_input_hash`,
  'completed',
  f.`created_at`
FROM `frames` f
-- Anti-join, not a correlated subquery. Matching `frame_id` as well as `id`
-- means only a row THIS backfill wrote suppresses the insert; a foreign row
-- squatting on the id hits the PRIMARY KEY and aborts the migration instead.
LEFT JOIN `frame_prompt_versions` v
  ON v.`id` = f.`id` AND v.`frame_id` = f.`id`
WHERE f.`image_prompt` IS NOT NULL
  AND f.`image_prompt` <> ''
  AND f.`selected_image_prompt_version_id` IS NULL
  AND v.`id` IS NULL;
--> statement-breakpoint
UPDATE `frames`
SET `selected_image_prompt_version_id` = m.`version_id`
FROM (
  -- `id = frame_id` is this backfill's signature: `generateId()` mints a fresh
  -- ULID per row, so an organic version id never equals its own frame's.
  SELECT v.`frame_id` AS `frame_id`, v.`id` AS `version_id`
  FROM `frame_prompt_versions` v
  WHERE v.`id` = v.`frame_id`
) AS m
WHERE m.`frame_id` = `frames`.`id`
  AND `frames`.`selected_image_prompt_version_id` IS NULL;
--> statement-breakpoint
-- Tripwire — see the motion backfill for the mechanism. A frame left holding
-- prompt text with no pointer loses it permanently when the mirror column goes,
-- so fail the deploy rather than ship the loss.
SELECT abs(-9223372036854775808)
FROM `frames` f
WHERE f.`image_prompt` IS NOT NULL
  AND f.`image_prompt` <> ''
  AND f.`selected_image_prompt_version_id` IS NULL
LIMIT 1;
