---
name: warn-run-check-migrations-after-generate
enabled: true
event: bash
action: warn
pattern: db:generate
---

⚠️ **After `db:generate`, verify migration D1 safety**

`drizzle-kit generate` only emits schema DDL. If you add **backfill DML** to `migration.sql` (common for pointer/seed migrations), it must be D1-safe:

1. **No** per-row correlated subqueries in `UPDATE` (`EXISTS (SELECT …)`, `SET x = (SELECT …)`)
2. **No** correlated `SELECT` per outer row in `INSERT … SELECT` — use `UPDATE … FROM` or a windowed subquery + `JOIN`
3. **No** `DROP TABLE` / `__new_` rebuilds — use `ALTER TABLE … ADD COLUMN` only

**Run the safety check on the new migration before committing:**

```bash
bun scripts/check-migrations.ts drizzle/migrations/<newest-dir>/migration.sql
```

Optionally confirm plans on local D1:

```bash
wrangler d1 execute DB --local --command "EXPLAIN QUERY PLAN …"
```

Pre-commit **migration-safety** in `lefthook.yml` runs the same script on staged SQL — fix failures before commit or deploy will freeze.
