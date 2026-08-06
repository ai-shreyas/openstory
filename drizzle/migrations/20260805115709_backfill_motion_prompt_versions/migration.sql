-- #1067 — give every shot carrying a `motion_prompt` a version row to point at,
-- so the mirror columns can be removed without losing a prompt.
--
-- Shots whose last motion prompt predates `mirrorSelection` have text in
-- `motion_prompt` and a NULL `selected_motion_prompt_version_id`. Reads fall
-- back to the mirror today; once it is gone they would resolve to an empty
-- prompt, which submits a blank render rather than failing.
--
-- The version row REUSES its shot's ULID. The id MUST be ULID-shaped: every
-- path that takes a version id back from the client validates it with
-- `ulidSchema` (26 chars, Crockford base32), so a prefixed `bfmp_<ulid>` would
-- be rejected by `restoreShotPromptVariantFn` — Restore would fail on exactly
-- the rows this backfill creates. Reuse is safe: at most one backfilled row per
-- shot, and production has 0 shots whose id already exists in
-- `shot_prompt_versions` (1384 to backfill, 0 collisions).
--
-- Because #989 gave an anchor frame its shot's id, that same ULID also names
-- the frame's image-prompt version row. `restoreShotPromptVariantFn` therefore
-- dispatches on an explicit `promptType` instead of probing which table holds
-- the id — see the note on `shotRestoreInput`.
--
-- Set-based, not correlated subqueries — those trip D1's remote CPU limit and
-- migrations apply BEFORE deploy, so a slow one freezes the deploy (#1019).
-- Idempotent: the INSERT anti-joins away rows this backfill already wrote, and
-- the UPDATE only touches NULL pointers.

INSERT INTO `shot_prompt_versions` (
  `id`, `shot_id`, `prompt_type`, `text`, `source`, `input_hash`,
  `status`, `created_at`
)
SELECT
  s.`id`,
  s.`id`,
  'motion',
  s.`motion_prompt`,
  'ai-generated',
  s.`motion_prompt_input_hash`,
  'completed',
  s.`created_at`
FROM `shots` s
-- Anti-join, not a correlated subquery. Matching `shot_id` as well as `id`
-- means only a row THIS backfill wrote suppresses the insert; a foreign row
-- squatting on the id hits the PRIMARY KEY and aborts the migration instead.
-- Loud beats silently skipping a shot that then loses its prompt.
LEFT JOIN `shot_prompt_versions` v
  ON v.`id` = s.`id` AND v.`shot_id` = s.`id`
WHERE s.`motion_prompt` IS NOT NULL
  AND s.`motion_prompt` <> ''
  AND s.`selected_motion_prompt_version_id` IS NULL
  AND v.`id` IS NULL;
--> statement-breakpoint
UPDATE `shots`
SET `selected_motion_prompt_version_id` = m.`version_id`
FROM (
  -- `id = shot_id` is this backfill's signature: `generateId()` mints a fresh
  -- ULID per row, so an organic version id never equals its own shot's.
  SELECT v.`shot_id` AS `shot_id`, v.`id` AS `version_id`
  FROM `shot_prompt_versions` v
  WHERE v.`id` = v.`shot_id` AND v.`prompt_type` = 'motion'
) AS m
WHERE m.`shot_id` = `shots`.`id`
  AND `shots`.`selected_motion_prompt_version_id` IS NULL;
--> statement-breakpoint
-- Tripwire. The migration after this one removes `motion_prompt`, so a shot
-- left holding text with no pointer loses its prompt permanently — fail the
-- deploy instead. SQLite has no ASSERT outside a trigger: `abs()` of the
-- minimum signed 64-bit integer raises "integer overflow", and it is only
-- evaluated if a row survives the filter. Returns no rows (and no error) when
-- the backfill is complete. An abort here means the UPDATE above did not reach
-- every shot; investigate before re-running.
SELECT abs(-9223372036854775808)
FROM `shots` s
WHERE s.`motion_prompt` IS NOT NULL
  AND s.`motion_prompt` <> ''
  AND s.`selected_motion_prompt_version_id` IS NULL
LIMIT 1;
