-- #1067 phase 2a — make `render_segments` + `video_variants` the real source of
-- truth for EVERY shot that has a video, so the `shots.video*` mirror can later
-- be dropped without losing anything.
--
-- WHY THIS IS NEEDED. The #990 cutover (20260629001734_nostalgic_expediter)
-- deliberately left the wiring incomplete: "the segment's selection pointer stays
-- NULL for legacy rows and the next render/select repoints it". It also only
-- created segments for shots that had a `shot_variants` row with
-- variant_type='video', so shots whose video predates that table got no segment
-- at all. Measured read-only on openstory-prd 2026-08-05:
--
--   3041 shots have video_url
--     1041 have NO render_segment_id                              <- steps 1-3
--     1887 have a segment whose selected_video_version_id is NULL <- step 4
--      113 fully wired (2074 render_segments, only 113 with a selection)
--
-- So `shots.video*` is currently the PRIMARY record for 2928 of 3041 videos, not
-- a mirror. Re-routing reads through the segment pointer before this backfill
-- would blank 2928 videos. This migration drops NO column — the drop is a
-- separate change, after this is deployed and re-measured in prod.
--
-- PRECONDITIONS VERIFIED ON PROD (exact counts, not estimates):
--   * of the 1041 orphan shots: 0 have a NULL motion_model (satisfies
--     video_variants.model NOT NULL), 0 have a NULL scene_id (satisfies
--     render_segments.scene_id NOT NULL), all 1041 video_urls are distinct, and
--     all have a non-null video_path and video_generated_at.
--   * of the 1887 segments needing a pointer, ALL 1887 resolve to EXACTLY ONE
--     non-discarded video_variants row by url match — 0 unmatched, 0 ambiguous.
--
-- JUDGEMENT CALL, 14 ROWS. Of the 1041 orphans, 1027 have video_status
-- 'completed' and 14 have 'failed' while still carrying a playable url, path and
-- generated_at (a later attempt failed and overwrote the status but not the
-- asset). The variant row records the ASSET THAT EXISTS, so all 1041 are written
-- as 'completed'; the failed attempt gets no variant row of its own because its
-- data was never retained beyond video_status/video_error. Writing those 14 as
-- 'failed' would make their segment's selected version fail any "completed"
-- check and blank a video that plays today.
--
-- ID REUSE. The segment id is the shot id, exactly as #990 did ("REUSES the
-- shot's id ... a deterministic key; resolution is always via
-- shots.render_segment_id, never by assuming id == shot_id"). The variant id is
-- also the shot id — a different table, so no collision, and each of these
-- segments has exactly one variant, so the ULID ordering the group index relies
-- on is unambiguous. Deterministic ids make every step replay-safe.
--
-- IDEMPOTENT. Every statement is guarded (WHERE NOT EXISTS / IS NULL), so a
-- replay is a no-op. INSERT and UPDATE only — no table rebuild, no DROP, so no
-- inbound ON DELETE CASCADE fires (#612).

-- 1) Degenerate one-shot render segment for every shot that has a video but no
--    segment. Selection is set in step 3, once its variant exists.
INSERT INTO `render_segments` (`id`, `scene_id`, `sequence_id`, `selected_video_version_id`, `created_at`, `updated_at`)
SELECT s.`id`, s.`scene_id`, s.`sequence_id`, NULL, s.`created_at`, s.`updated_at`
FROM `shots` s
WHERE s.`video_url` IS NOT NULL
  AND s.`render_segment_id` IS NULL
  AND s.`scene_id` IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM `render_segments` rs WHERE rs.`id` = s.`id`);--> statement-breakpoint

-- 2) The video version itself, built from the mirror columns. The manifest shape
--    matches #990: one entry per covered shot, referencing the shot's currently
--    selected motion-prompt and anchor-frame image versions (null where none).
--    input_hash stays NULL — every one of these rows has a NULL video_input_hash
--    on prod, and fabricating one would read as "freshly verified".
INSERT INTO `video_variants` (
	`id`, `render_segment_id`, `sequence_id`, `model`, `manifest`,
	`url`, `storage_path`, `preview_url`, `status`, `workflow_run_id`,
	`generated_at`, `error`, `input_hash`, `discarded_at`, `created_at`, `updated_at`
)
SELECT
	s.`id`, s.`id`, s.`sequence_id`, s.`motion_model`,
	json_array(json_object(
		'shotId', s.`id`,
		'motionPromptVersionId', s.`selected_motion_prompt_version_id`,
		'frameVersionId', f.`selected_image_version_id`,
		'durationMs', COALESCE(s.`duration_ms`, 0)
	)),
	s.`video_url`, s.`video_path`, NULL, 'completed', s.`video_workflow_run_id`,
	s.`video_generated_at`, NULL, NULL, NULL, s.`created_at`, s.`updated_at`
FROM `shots` s
LEFT JOIN `frames` f ON f.`shot_id` = s.`id` AND f.`order_index` = 0
WHERE s.`video_url` IS NOT NULL
  AND s.`render_segment_id` IS NULL
  AND s.`scene_id` IS NOT NULL
  AND EXISTS (SELECT 1 FROM `render_segments` rs WHERE rs.`id` = s.`id`)
  AND NOT EXISTS (SELECT 1 FROM `video_variants` vv WHERE vv.`id` = s.`id`);--> statement-breakpoint

-- 3) Point each new segment at its version, then link the shot to the segment.
--    Set-based `UPDATE … FROM` throughout: a correlated per-row subquery here
--    scans `video_variants` / `render_segments` once per candidate row and trips
--    D1's remote CPU-time limit (7429), which freezes the DEPLOY because
--    migrations apply before it (#1019). The driver is scanned once; the target
--    is searched by primary key.
UPDATE `render_segments`
SET `selected_video_version_id` = v.`id`
FROM (SELECT `id`, `render_segment_id` FROM `video_variants`) AS v
WHERE v.`render_segment_id` = `render_segments`.`id`
  AND v.`id` = `render_segments`.`id`
  AND `render_segments`.`selected_video_version_id` IS NULL;--> statement-breakpoint

UPDATE `shots`
SET `render_segment_id` = rs.`id`
FROM (SELECT `id` FROM `render_segments`) AS rs
WHERE rs.`id` = `shots`.`id`
  AND `shots`.`video_url` IS NOT NULL
  AND `shots`.`render_segment_id` IS NULL;--> statement-breakpoint

-- 4) Legacy #990 segments that never got a selection: point each at the
--    non-discarded variant whose url is the one its shot serves today.
--    Verified 1:1 on prod — 1887 segments, 1887 exact single matches, so the
--    join below yields at most one row per segment.
UPDATE `render_segments`
SET `selected_video_version_id` = m.`variant_id`
FROM (
	SELECT s2.`render_segment_id` AS `segment_id`, vv.`id` AS `variant_id`
	FROM `shots` s2
	JOIN `video_variants` vv
	  ON vv.`render_segment_id` = s2.`render_segment_id`
	 AND vv.`url` = s2.`video_url`
	 AND vv.`discarded_at` IS NULL
	WHERE s2.`video_url` IS NOT NULL
	  AND s2.`render_segment_id` IS NOT NULL
) AS m
WHERE m.`segment_id` = `render_segments`.`id`
  AND `render_segments`.`selected_video_version_id` IS NULL;
