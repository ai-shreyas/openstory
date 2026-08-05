---
name: block-remote-db-ops
enabled: true
event: bash
action: block
pattern: db:(migrate|push|studio|seed):(d1|prd)|cf:deploy:prd|deploy:production|setup:(prd|stg|deploy)|drizzle\.config\.d1\.ts|wrangler\s+d1\s+migrations\s+apply[^;|&]*--remote|wrangler\s+d1\s+execute[^;|&]*--remote[^;|&]*--file|wrangler\s+d1\s+execute[^;|&]*--remote[^;|&]*\b(INSERT|insert|UPDATE|update|DELETE|delete|DROP|drop|ALTER|alter|CREATE|create|REPLACE|replace|TRUNCATE|truncate|VACUUM|vacuum|ATTACH|attach)\b|wrangler\s+d1\s+execute[^;|&]*\b(INSERT|insert|UPDATE|update|DELETE|delete|DROP|drop|ALTER|alter|CREATE|create|REPLACE|replace|TRUNCATE|truncate|VACUUM|vacuum|ATTACH|attach)\b[^;|&]*--remote
---

🚫 **Remote database WRITE blocked!**

You attempted a command that **mutates** the remote Cloudflare D1 database or a remote deploy target. These skip local sandboxing and can destroy production data (#612 destroyed `team_members`, `session`, `account`, and `passkey` in prod).

**Reads against prod are allowed** — this rule only fires on writes. A read-only query needs no approval:

```
wrangler d1 execute openstory-prd --env=production --remote --command "SELECT count(*) FROM shots"
```

What still trips the block: any `INSERT`/`UPDATE`/`DELETE`/`DROP`/`ALTER`/`CREATE`/`REPLACE`/`TRUNCATE`/`VACUUM`/`ATTACH` alongside `--remote`, plus `--file=` against `--remote` (the file's contents can't be inspected from the command line, so it's treated as a write).

**Safe local equivalents:**

- `bun db:migrate:local` — apply migrations to local D1
- `bun db:studio:local` — inspect local D1
- `bun db:seed:local` — seed local D1
- `wrangler d1 execute DB --local …` — run any SQL against the local D1 binding

**To intentionally write to a remote database:**

1. Ask the human to run the command themselves (they can prefix it with `!` in the Claude Code prompt), OR
2. Have them set `enabled: false` here for a single deploy, then re-enable it immediately afterwards.

**Why each pattern is blocked:**

- `db:migrate:prd`, `deploy:production`, `cf:deploy:prd` — run `wrangler d1 migrations apply --env=production --remote`, the exact path that caused #612
- `wrangler d1 migrations apply … --remote` — the same, invoked directly
- `db:*:d1` / `drizzle.config.d1.ts` — drizzle-kit pointed at live infra
- `setup:prd|stg|deploy` — provisions / mutates remote Cloudflare resources
