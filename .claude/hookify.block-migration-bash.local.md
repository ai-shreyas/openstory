---
name: block-migration-bash
enabled: true
event: bash
action: warn
pattern: (rm|mv|cp|sed\s+-i|echo\s*>|tee|truncate).*drizzle/migrations/(meta/|[^/]+/snapshot\.json)|(rm|mv)\s+(-[^\s]*\s+)*drizzle/migrations/[0-9]|drizzle/migrations/(meta/|[^/]+/snapshot\.json).*(>|>>)
---

🚫 **Drizzle migration metadata modification blocked!**

You attempted to modify **journal / snapshot** files or remove a migration directory via bash.

**Note:** Reading migration files (`cat`, `head`, `less`) is allowed.

**Allowed via editor tools:** `drizzle/migrations/<dir>/migration.sql` — add D1-safe backfill DML after `db:generate`; run `bun scripts/check-migrations.ts` before commit.

**Blocked via bash:** `drizzle/migrations/meta/`, any `snapshot.json`, deleting whole migration directories.

**To fix a bad migration generation, ask the user first, then:**

1. Delete the problematic migration directory
2. Remove its entry from `drizzle/migrations/meta/_journal.json`
3. Regenerate with `bun db:generate:local`
