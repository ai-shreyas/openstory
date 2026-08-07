-- #1067 — a scene's script lives in `scene_script_versions`, not a mirror.
--
-- `scenes.original_script` duplicated the content of the version row
-- `selected_script_version_id` points at. Every reader already preferred the
-- version and fell back to the column; verified against production before the
-- drop — all 4334 scenes have a selected version, so the fallback was dead.
--
-- 3 of those scenes had ALREADY diverged: their selected version's content
-- differed from the mirror, so they were rendering stale script text. Removing
-- the mirror fixes them rather than losing anything.
--
-- `seedSplitVersions` used to seed the version rows BY READING this column; it
-- now takes the script explicitly from the in-memory scene, so splitting still
-- creates a version for every scene.
--
-- DROP COLUMN rebuilds no table, so the #612 cascade trap does not apply.

ALTER TABLE `scenes` DROP COLUMN `original_script`;
