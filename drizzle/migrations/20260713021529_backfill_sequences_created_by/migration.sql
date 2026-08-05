-- Restore `sequences.created_by` (and `updated_by`) nulled by the #612-class
-- table-rebuild migration (2026-04-29, `20260428013041_productive_kabuki`).
-- Both columns are `ON DELETE SET NULL` FKs to `user`; the SQLite table-rebuild
-- pattern drops+recreates the `user` table inside D1's implicit multi-statement
-- txn, which fired those FKs and nulled the creator on every then-existing
-- sequence.
--
-- Every affected sequence is in a single-member team (verified in prod: all 174
-- null-creator rows have exactly one team member), so that sole member IS the
-- original creator — accurate reconstruction, not a guess. The `n = 1` guard
-- makes that explicit and no-ops on any multi-member team.
--
-- D1-safe (CLAUDE.md / #612): DML only, no table rebuild / DROP / DELETE. One
-- grouped scan of `team_members` joined once to `sequences` — set-based, no
-- per-row correlated subquery (#1019). `updated_by` is fill-only via COALESCE so
-- an already-set editor is never clobbered.
UPDATE sequences
SET created_by = m.user_id,
    updated_by = COALESCE(sequences.updated_by, m.user_id)
FROM (
	SELECT team_id, MIN(user_id) AS user_id, COUNT(*) AS n
	FROM team_members
	GROUP BY team_id
) AS m
WHERE m.team_id = sequences.team_id
	AND m.n = 1
	AND sequences.created_by IS NULL;
