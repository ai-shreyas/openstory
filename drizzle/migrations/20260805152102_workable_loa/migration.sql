-- #1067 — drop the UNIQUE prompt dedupe indexes; dedupe on content instead.
--
-- `input_hash` was doing two jobs: recording the upstream context a prompt
-- aligns with (what staleness compares against), and acting as the dedupe slot
-- for a UNIQUE index on (frame_id, input_hash). Retry idempotency is really
-- (frame, input_hash, text) — same context AND same output — so a force-regen
-- (same context, NEW text) collided and had to insert with input_hash NULL to
-- escape the index, throwing the alignment fact away. The mirror columns
-- (`frames.image_prompt` / `visual_prompt_input_hash`, `shots.motion_prompt*`)
-- existed to carry it back.
--
-- `write` now matches all three columns before inserting, so every row keeps
-- its real hash and the mirrors are unnecessary. What remains is the plain
-- lookup index that match reads. The live-claim UNIQUE index is untouched — it
-- is what guards concurrent double-spend (#1085).

DROP INDEX IF EXISTS `uq_frame_prompt_versions_frame_hash_ai`;--> statement-breakpoint
DROP INDEX IF EXISTS `uq_shot_prompt_variants_shot_type_hash_ai`;--> statement-breakpoint
CREATE INDEX `idx_frame_prompt_versions_frame_hash` ON `frame_prompt_versions` (`frame_id`,`input_hash`);--> statement-breakpoint
CREATE INDEX `idx_shot_prompt_versions_shot_type_hash` ON `shot_prompt_versions` (`shot_id`,`prompt_type`,`input_hash`);
