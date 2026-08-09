-- #1101 — carry the previews off `frames.preview_image_url`, THEN drop it.
--
-- The backfill lives in this file rather than its own migration on purpose: the
-- column is the ONLY copy of every preview the product has (the legacy path
-- wrote the column and minted no variant row), so applying the drop without the
-- backfill deletes them. Same file = same statement list = the two can never be
-- applied apart, which a sibling migration ordered only by its timestamp could
-- not guarantee.
--
-- fal CDN urls are described as short-lived but do not actually expire, so
-- these values are live images, not dead links.
--
-- SYNTHETIC IDS. Every other id here is a ULID, and the preview reads order by
-- id as a proxy for time (`ORDER BY id DESC LIMIT 1`), so a backfilled row must
-- sort OLDER than any preview a later run records — otherwise it would outrank
-- the fresh one forever. `'00' || f.id` gives exactly that:
--   * unique — bijective in the frame id, and at most one row per frame.
--   * unconditionally oldest — a ULID's leading chars encode a 48-bit ms
--     timestamp, and '00…' decodes to before 2004, so no real ULID sorts below
--     it. It also cannot collide with the #989 rows that reused shot ids, since
--     those are real ULIDs.
-- `generated_at` uses the frame's `updated_at`: the real generation time was
-- never recorded anywhere except the row this path never wrote.
--
-- Set-based single INSERT…SELECT, and the idempotency guard is an anti-join
-- rather than a correlated NOT EXISTS — a per-row subquery over `frames` trips
-- D1's remote CPU limit, and migrations apply BEFORE deploy, so a slow one
-- freezes the deploy (#1019). The join is on `frame_variants`' primary key, so
-- it is an index lookup per driver row. Re-running matches 0 rows.
--
-- The DROP COLUMNs below are plain ALTERs, not the CREATE/INSERT/DROP/RENAME
-- table-rebuild pattern, so no inbound cascade fires and #612 does not apply.
INSERT INTO `frame_variants` (
  `id`, `frame_id`, `sequence_id`, `kind`, `model`,
  `url`, `storage_path`, `status`, `generated_at`,
  `prompt_hash`, `prompt_version_id`, `workflow_run_id`,
  `created_at`, `updated_at`
)
SELECT
  '00' || f.`id`, f.`id`, f.`sequence_id`, 'preview', 'flux_2_turbo',
  f.`preview_image_url`, NULL, 'completed', f.`updated_at`,
  NULL, NULL, NULL,
  f.`created_at`, f.`updated_at`
FROM `frames` f
LEFT JOIN `frame_variants` fv ON fv.`id` = '00' || f.`id`
WHERE f.`preview_image_url` IS NOT NULL
  AND fv.`id` IS NULL;--> statement-breakpoint
ALTER TABLE `frame_variants` DROP COLUMN `preview_url`;--> statement-breakpoint
ALTER TABLE `frames` DROP COLUMN `preview_image_url`;--> statement-breakpoint
ALTER TABLE `shot_variants` DROP COLUMN `preview_url`;--> statement-breakpoint
ALTER TABLE `video_variants` DROP COLUMN `preview_url`;
