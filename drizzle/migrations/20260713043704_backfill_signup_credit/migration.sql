-- Custom SQL migration file, put your code below! --
-- +$10 welcome credit for every existing team (#1047). $10 = 10,000,000 microdollars.
-- D1-safe: DML only, set-based INSERT…SELECT (no rebuild/DROP/DELETE/per-row subquery).
INSERT INTO `credits` ("team_id", "balance", "updated_at")
  SELECT "id", 10000000, unixepoch('now') FROM `teams` WHERE true
  ON CONFLICT("team_id") DO UPDATE SET "balance" = "balance" + 10000000, "updated_at" = unixepoch('now');
--> statement-breakpoint
INSERT INTO `transactions` ("id","team_id","user_id","type","amount","balance_after","metadata","description","created_at")
  SELECT lower(hex(randomblob(16))), "team_id", NULL, 'credit_adjustment', 10000000, "balance",
         '{"signupGrant":true,"backfill":true}', 'Welcome credit: $10.00', unixepoch('now') FROM `credits`;
--> statement-breakpoint
INSERT INTO `credit_batches` ("id","team_id","original_amount","remaining_amount","source","expires_at","created_at")
  SELECT lower(hex(randomblob(16))), "team_id", 10000000, 10000000, 'migration',
         unixepoch('now', '+12 months'), unixepoch('now') FROM `credits`;