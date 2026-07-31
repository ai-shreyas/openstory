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
 *
 * 3. The observed-median query returning nothing. Every failure mode here is
 *    silent — an empty result is indistinguishable from "no generations yet",
 *    so the refresh logs success while the feature is inert. The first cut
 *    compared the seconds-denominated `createdAt` against a millisecond
 *    cutoff and could never match a row.
 */

import { createClient } from '@libsql/client';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  computeObservedUnits,
  FAL_PRICING_CRON,
  HISTORY_CHUNK,
  UPSERT_CHUNK,
} from '@/lib/cron/refresh-fal-pricing';
import { modelPricing, modelPricingHistory } from '@/lib/db/schema';
import { modelUsageObservations } from '@/lib/db/schema/model-pricing';
import { getTableColumns } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

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

describe('computeObservedUnits', () => {
  const client = createClient({ url: ':memory:' });
  const db = drizzle({ client });

  beforeEach(async () => {
    await migrate(db, { migrationsFolder: './drizzle/migrations' });
    await db.delete(modelUsageObservations);
  });

  test('sees observations written now (cutoff units must match the column)', async () => {
    await db.insert(modelUsageObservations).values({
      provider: 'fal',
      endpointId: 'xai/grok-imagine',
      unitsBilled: 294,
      numImages: 1,
    });

    const { observed, samples } = await computeObservedUnits(db);

    // `createdAt` is stored in seconds; comparing it against a millisecond
    // cutoff matched zero rows and pinned every model to the $0.10 floor.
    expect(samples).toBe(1);
    expect(observed.get('xai/grok-imagine')).toEqual({
      medianUnits: 294,
      sampleCount: 1,
    });
  });

  test('divides unitsBilled by numImages so the median is per image', async () => {
    // The estimator multiplies its per-image count back up by numImages, so a
    // 4-image call must not contribute a 4x sample.
    await db.insert(modelUsageObservations).values([
      {
        provider: 'fal',
        endpointId: 'fal-ai/flux-2',
        unitsBilled: 8,
        numImages: 4,
      },
      {
        provider: 'fal',
        endpointId: 'fal-ai/flux-2',
        unitsBilled: 4,
        numImages: 4,
      },
    ]);

    const { observed } = await computeObservedUnits(db);

    expect(observed.get('fal-ai/flux-2')).toEqual({
      medianUnits: 1.5,
      sampleCount: 2,
    });
  });

  test('ignores samples older than the observation window', async () => {
    await db.insert(modelUsageObservations).values({
      provider: 'fal',
      endpointId: 'fal-ai/flux-2',
      unitsBilled: 99,
      numImages: 1,
      createdAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000),
    });

    const { observed, samples } = await computeObservedUnits(db);

    expect(samples).toBe(0);
    expect(observed.size).toBe(0);
  });
});
