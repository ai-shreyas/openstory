-- #1067 — demote historical added-model FAILURES out of the primary slot.
--
-- `20260805074838_happy_richard_fisk` added `video_variants.is_primary` with
-- `DEFAULT true`, and its own header flagged the consequence it did not fix:
-- "Existing rows default to primary: a historical variant-only FAILURE may
-- therefore read as a primary failure until its shot is re-rendered."
--
-- That matters because `toShotView` now derives a shot's whole video lifecycle
-- from its NEWEST primary version. A shot with a good selected video plus a
-- newer failed added-model experiment (`variantOnly`, #547 — a shipped feature,
-- so these rows exist) reads `videoStatus: 'failed'` after the deploy: the
-- working video disappears behind a failure banner, `analyzeFailures` groups it
-- as a failed shot, and smart-retry re-renders — spending credits to reproduce
-- a video that already exists.
--
-- WHAT IS DEMOTED — deliberately narrow. A row is demoted only when all hold:
--   * status = 'failed'          — a completed added-model render is harmless;
--                                  it is not selected, so it changes no status.
--   * it is NOT the segment's selection  — the selection is by definition the
--                                  primary result.
--   * the segment HAS a selection — without a playable video there is no good
--                                  video to hide, and 'failed' is the honest
--                                  status.
--   * its model DIFFERS from the selected version's model — this is the
--                                  discriminator. A failed re-roll of the SAME
--                                  model IS a primary failure and must keep
--                                  reading 'failed' (that is the #1067 design:
--                                  re-rolling over a good video shows its
--                                  lifecycle). Only another model's render was
--                                  ever an "added model" experiment.
--
-- Rows written after this deploy are unaffected: `motion-workflow` sets
-- `isPrimary: !input.variantOnly` explicitly, so only pre-deploy rows can carry
-- the wrong default. No timestamp filter is needed.
--
-- Set-based `UPDATE … FROM`, not correlated subqueries — those trip D1's remote
-- CPU limit, and migrations apply BEFORE deploy, so a slow one freezes the
-- deploy (#1019). Idempotent: re-running re-writes 0 to 0.
--
-- Touches no schema, so there is no table rebuild and the #612 cascade trap
-- does not apply.

UPDATE `video_variants`
SET `is_primary` = false
FROM (
  SELECT vv.`id` AS `version_id`
  FROM `video_variants` vv
  JOIN `render_segments` rs ON rs.`id` = vv.`render_segment_id`
  JOIN `video_variants` sel ON sel.`id` = rs.`selected_video_version_id`
  WHERE vv.`status` = 'failed'
    AND vv.`id` <> sel.`id`
    AND vv.`model` <> sel.`model`
) m
WHERE `video_variants`.`id` = m.`version_id`;
