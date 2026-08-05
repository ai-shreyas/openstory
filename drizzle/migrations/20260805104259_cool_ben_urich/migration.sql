-- #1067 — a shot stores no scene data. `metadata` was the whole analysis Scene
-- copied onto every shot; `description` was a split-time copy of the script
-- extract that nothing updated, so it went stale on the first script edit.
-- Both resolve through `sceneId` now. D1-safe: DROP COLUMN only, no rebuild.
ALTER TABLE `shots` DROP COLUMN `description`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `metadata`;