-- #1067 — drop the `frames.image*` mirror of `frame_variants`.
--
-- These five columns were a copy of the version `frames.selected_image_version_id`
-- points at, written by `buildFrameImageMirror`. Reads now resolve the selected
-- `frame_variants` row directly (`projectShotWithImage`), so the copy has no
-- readers left. Measured before the drop: 50/50 frames with an image had the
-- pointer set, with zero divergence on any of these columns — the mirror was
-- never the sole source for any row.
--
-- What deliberately REMAINS on `frames`: `preview_image_url` (the turbo stand-in
-- shown before any variant exists — see #1101), and `image_status` /
-- `image_error` / `image_workflow_run_id`, which track the PRIMARY render's
-- lifecycle and have no `frame_variants` equivalent (a `variantOnly` render must
-- not move them, and a failed primary clears `pending_promote_version_id`).
--
-- D1-safe: `ALTER TABLE … DROP COLUMN` only — no table rebuild, so no inbound
-- ON DELETE CASCADE fires (#612).
ALTER TABLE `frames` DROP COLUMN `image_url`;--> statement-breakpoint
ALTER TABLE `frames` DROP COLUMN `image_path`;--> statement-breakpoint
ALTER TABLE `frames` DROP COLUMN `image_generated_at`;--> statement-breakpoint
ALTER TABLE `frames` DROP COLUMN `image_model`;--> statement-breakpoint
ALTER TABLE `frames` DROP COLUMN `image_input_hash`;
