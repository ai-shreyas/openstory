/**
 * Run the daily fal pricing refresh against a local D1, filling
 * `model_pricing` (Bun autoloads `.env.local`; use `--env-file=` to override):
 *
 *   bun scripts/refresh-fal-pricing.ts            # default env (bun dev)
 *   bun scripts/refresh-fal-pricing.ts --test     # [env.test] (Playwright)
 *
 * `bun dev` does NOT fire Cloudflare's `scheduled()` handler, and the table is
 * the platform's only pricing record — until this runs, estimates gate on the
 * unknown floor and billing records $0. Uses FAL_KEY, matching the cron.
 * Writes only the derived pricing cache; safe to re-run.
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

// Admin-scoped key for the usage-API overlay (billed-rate verification).
const billingKey =
  process.env.FAL_BILLING_KEY ?? process.env.FAL_BILLING_KEY_DEV;

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
    billingKey,
  });

  console.log('✅ model_pricing refreshed\n');
  for (const [key, value] of Object.entries(summary)) {
    console.log(`   ${key.padEnd(20)} ${value}`);
  }
} finally {
  await platformProxy.dispose();
}
