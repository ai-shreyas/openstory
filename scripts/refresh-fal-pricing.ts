/**
 * Run the daily fal pricing refresh against a local D1, filling `model_pricing`
 * (Bun autoloads `.env.local`; use `--env-file=` to override):
 *
 *   bun scripts/refresh-fal-pricing.ts            # default env (bun dev)
 *   bun scripts/refresh-fal-pricing.ts --test     # [env.test] (Playwright)
 *
 * `bun dev` does NOT fire Cloudflare's `scheduled()` handler, so locally an
 * empty `model_pricing` is the permanent steady state, not a first-run blip.
 * Everything still works — `getEffectiveFalPricing` merges the table over the
 * baked-in `FAL_PRICING` seed, and an empty table simply means "no overrides"
 * — but the compute-seconds endpoints that have no seeded
 * `typicalUnitsPerCall` (the original #1069 six) gate on the $0.10
 * unknown-estimate floor until an observed median lands. Run this to exercise
 * the real path.
 *
 * Uses **FAL_KEY**, matching the cron. The separate `FAL_PRICING_KEY` that
 * `update-fal-pricing.ts` and `verify-fal-costs.ts --compare` want is a fal
 * *admin* key; both keys are accepted by the two pricing endpoints this
 * touches, so there is nothing to reconcile for this script.
 *
 * This writes only the derived pricing cache — no team or user data — and is
 * safe to re-run. It is the same function the Worker cron calls.
 */
import { refreshFalPricing } from '@/lib/cron/refresh-fal-pricing';
import { drizzle } from 'drizzle-orm/d1';
import { relations } from '@/lib/db/schema/relations';
import { getLocalPlatformProxy } from './local-platform-proxy';

const apiKey = process.env.FAL_KEY;
if (!apiKey) {
  console.error('FAL_KEY not set (add it to .env.local)');
  process.exit(1);
}

const environment = process.argv.includes('--test') ? 'test' : undefined;
console.log(`🗄️  Wrangler local D1 (${environment ?? 'default'} env)\n`);

const platformProxy = await getLocalPlatformProxy<{ DB?: D1Database }>({
  environment,
});
try {
  const binding = platformProxy.env.DB;
  if (!binding) {
    throw new Error(
      `D1 binding 'DB' missing from wrangler.jsonc ${environment ? `[env.${environment}]` : ''}`
    );
  }

  const summary = await refreshFalPricing({
    db: drizzle(binding, { relations }),
    apiKey,
  });

  console.log('✅ model_pricing refreshed\n');
  for (const [key, value] of Object.entries(summary)) {
    console.log(`   ${key.padEnd(20)} ${value}`);
  }
} finally {
  await platformProxy.dispose();
}
