-- #1067 — drop 17 columns that were dead by construction: the scene-level
-- video render, per-shot audio, and `frames.source`.
--
-- Measured read-only on openstory-prd 2026-08-05 (4329 scenes, 4329 shots,
-- 4329 frames — strictly 1:1:1):
--
--   `scenes.video_*` / `render_strategy` — 0 non-null rows on video_url,
--   video_path, video_workflow_run_id, video_generated_at, video_error,
--   video_input_hash and render_strategy; video_status is the 'pending'
--   default on all 4329. Never written by any code path: a scene's render is
--   tiled into `render_segments` (#990), which owns the selection pointer.
--
--   `shots.audio_*` — 0 non-null rows on audio_url, audio_path,
--   audio_workflow_run_id, audio_generated_at, audio_error, audio_model and
--   audio_input_hash; audio_status is the 'pending' default on all 4329.
--   Per-shot audio was never built — music is sequence-level (`sequences.music*`)
--   and dialogue rides inside the video. The only writer was the unreachable
--   `variantType: 'audio'` branch of `buildPromoteUpdate`.
--
--   `frames.source` — 'generated' on all 4329, no other value present. The
--   documented in-place 'preview' → 'generated' flip was never implemented;
--   preview-ness is expressed as `preview_image_url != null` (see #1101).
--
-- D1-safe: `ALTER TABLE … DROP COLUMN` only — no table rebuild, so no inbound
-- ON DELETE CASCADE fires (#612).
ALTER TABLE `frames` DROP COLUMN `source`;--> statement-breakpoint
ALTER TABLE `scenes` DROP COLUMN `video_url`;--> statement-breakpoint
ALTER TABLE `scenes` DROP COLUMN `video_path`;--> statement-breakpoint
ALTER TABLE `scenes` DROP COLUMN `video_status`;--> statement-breakpoint
ALTER TABLE `scenes` DROP COLUMN `video_workflow_run_id`;--> statement-breakpoint
ALTER TABLE `scenes` DROP COLUMN `video_generated_at`;--> statement-breakpoint
ALTER TABLE `scenes` DROP COLUMN `video_error`;--> statement-breakpoint
ALTER TABLE `scenes` DROP COLUMN `video_input_hash`;--> statement-breakpoint
ALTER TABLE `scenes` DROP COLUMN `render_strategy`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `audio_url`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `audio_path`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `audio_status`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `audio_workflow_run_id`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `audio_generated_at`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `audio_error`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `audio_model`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `audio_input_hash`;