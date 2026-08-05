-- #1067 phase 2d — drop the `shots.video*` mirror of `video_variants`.
--
-- These five columns were a copy of the version a shot's render segment points
-- at (`render_segments.selected_video_version_id`), written by the function
-- formerly called `buildShotVideoMirror`. Reads now resolve that version
-- directly (`projectShotWithImage`, batched via
-- `videoVariants.getSelectedByShotIds`), so the copy has no readers left.
--
-- Gated on the phase 2a backfill (`20260805044544_backfill_video_segments_and_
-- selection`, PR #1105) landing in prod FIRST. Before it, `shots.video*` was the
-- PRIMARY record, not a mirror: of 3041 shots with a `video_url`, 1041 had no
-- `render_segment_id` at all and 1887 more pointed at a segment whose selection
-- was NULL — only 113 of 2074 segments carried one. The backfill took
-- unresolvable videos to 0 (rehearsed on a full `wrangler d1 export` of prod:
-- +1041 rows to each of `render_segments`/`video_variants`, 0 pre-existing
-- selections changed, 0 FK violations). Re-verified as 0 against prod before
-- this drop was written — that check is what the #990 cutover skipped when it
-- left legacy rows for "the next render/select" to repoint, and why they sat
-- unrepointed for five weeks.
--
-- What deliberately REMAINS on `shots`: `video_status` / `video_error` /
-- `video_workflow_run_id`. `videoVariants.select` refuses any version that is
-- not 'completed', so the selection pointer structurally cannot carry in-flight
-- or failed state; and `persistMotionFailure` records a failure on the shot only
-- for a PRIMARY render (`!variantOnly`) — a distinction stored nowhere on the
-- variant row, with `pending_promote_version_id` cleared on failure so no
-- pointer survives to carry it. Same reasoning that kept `frames.image_status` /
-- `image_error` / `image_workflow_run_id` in the phase 1 drop.
--
-- D1-safe: `ALTER TABLE … DROP COLUMN` only — no table rebuild, so no inbound
-- ON DELETE CASCADE fires (#612).
ALTER TABLE `shots` DROP COLUMN `video_url`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `video_path`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `video_generated_at`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `motion_model`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `video_input_hash`;