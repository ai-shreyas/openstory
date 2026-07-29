/**
 * Guards for the daily pricing refresh (#1069).
 *
 * Two classes of failure that production would not surface:
 *
 * 1. Cron wiring. `scheduled()` routes on an exact string match against
 *    `FAL_PRICING_CRON` and returns early. If `wrangler.jsonc` drifts, the
 *    refresh never runs AND the drifted expression falls through to the
 *    stuck-job reconcile sweep — which succeeds, so nothing fails. Pricing
 *    just quietly freezes at the seed. (Same three-places problem the
 *    workflow wiring test exists for.)
 *
 * 2. D1's 100-bound-param ceiling. Unit tests run on libsql, which has no
 *    such cap, so an over-wide chunk passes CI and throws only in production
 *    (the #1019 class of bug). Assert the arithmetic directly against the
 *    real column counts instead of trusting a comment.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  FAL_PRICING_CRON,
  HISTORY_CHUNK,
  UPSERT_CHUNK,
} from '@/lib/cron/refresh-fal-pricing';
import { modelPricing, modelPricingHistory } from '@/lib/db/schema';
import { getTableColumns } from 'drizzle-orm';

const WRANGLER_PATH = 'wrangler.jsonc';

/** D1 rejects a query binding more than this many params. */
const D1_MAX_BOUND_PARAMS = 100;

describe('fal pricing cron wiring', () => {
  const wrangler = readFileSync(WRANGLER_PATH, 'utf-8');

  test('the cron expression is registered in the default block', () => {
    // The default block drives `bun dev` and is the patch base for PR previews.
    const defaultCrons = wrangler.slice(0, wrangler.indexOf('"env"'));
    expect(defaultCrons).toContain(FAL_PRICING_CRON);
  });

  test('the cron expression is registered in [env.production]', () => {
    // Production builds bake this block; a missing entry means the job never
    // runs in prod no matter what the code says.
    const productionBlock = wrangler.slice(wrangler.indexOf('"production"'));
    expect(productionBlock).toContain(FAL_PRICING_CRON);
  });

  test('the reconcile sweep still has its own schedule', () => {
    // refreshFalPricing returns early on its match; the 5-minute sweep must
    // remain the fall-through case.
    expect(wrangler).toContain('*/5 * * * *');
    expect(FAL_PRICING_CRON).not.toBe('*/5 * * * *');
  });
});

describe('D1 bound-param ceiling', () => {
  test('model_pricing upserts stay under the cap', () => {
    const columns = Object.keys(getTableColumns(modelPricing)).length;
    expect(columns * UPSERT_CHUNK).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
  });

  test('model_pricing_history inserts stay under the cap', () => {
    // `id` binds too — it comes from $defaultFn, not a SQL default (#1019).
    const columns = Object.keys(getTableColumns(modelPricingHistory)).length;
    expect(columns * HISTORY_CHUNK).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
  });
});
