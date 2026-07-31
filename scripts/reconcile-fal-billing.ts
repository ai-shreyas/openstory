/**
 * Run the hourly fal billing reconcile against a local D1 (Bun autoloads
 * `.env.local`): audits recent charges against fal's per-request bill and
 * corrects `model_pricing` rates. Needs FAL_BILLING_KEY (or
 * FAL_BILLING_KEY_DEV) — an admin-scoped fal key.
 *
 *   bun scripts/reconcile-fal-billing.ts            # default env (bun dev)
 *   bun scripts/reconcile-fal-billing.ts --test     # [env.test] (Playwright)
 */
import { reconcileFalBilling } from '@/lib/cron/reconcile-fal-billing';
import { drizzle } from 'drizzle-orm/d1';
import { relations } from '@/lib/db/schema/relations';
import { getLocalPlatformProxy } from './local-platform-proxy';

const billingKey =
  process.env.FAL_BILLING_KEY ?? process.env.FAL_BILLING_KEY_DEV;
if (!billingKey) {
  console.error('FAL_BILLING_KEY not set (add it to .env.local)');
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

  const summary = await reconcileFalBilling({
    db: drizzle(binding, { relations }),
    billingKey,
  });

  console.log('✅ fal billing reconciled\n');
  for (const [key, value] of Object.entries(summary ?? {})) {
    console.log(`   ${key.padEnd(22)} ${value}`);
  }
} finally {
  await platformProxy.dispose();
}
