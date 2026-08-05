---
name: block-migration-edits
enabled: true
event: file
action: warn
conditions:
  - field: file_path
    operator: regex_match
    pattern: drizzle/migrations/(meta/|.*/snapshot\.json$)
  - field: new_text
    operator: regex_match
    pattern: .+
---

🚫 **Drizzle migration metadata edit blocked!**

Journal entries and `snapshot.json` files are **drizzle-kit outputs** — do not hand-edit them.

**Allowed:** editing `drizzle/migrations/<dir>/migration.sql` after `db:generate` (e.g. D1-safe backfill DML). Unsafe SQL is blocked separately by `hookify.block-d1-unsafe-migration-sql`.

**Workflow:**

1. Change `src/lib/db/schema/`
2. `bun db:generate:local`
3. Hand-edit **`migration.sql` only** if backfill DML is needed — use set-based `UPDATE … FROM` / windowed `JOIN` (#1019), no table rebuild (#612)
4. `bun scripts/check-migrations.ts drizzle/migrations/<dir>/migration.sql` (must exit 0; lefthook runs this at pre-commit)

**To fix a bad migration generation (journal/snapshot), ask the user first, then:**

1. Delete the problematic migration directory
2. Remove its entry from `drizzle/migrations/meta/_journal.json`
3. Regenerate with `bun db:generate:local`
