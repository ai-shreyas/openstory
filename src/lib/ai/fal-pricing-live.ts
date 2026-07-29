/**
 * Live fal pricing for pre-flight estimation (#1069).
 *
 * Merges the `model_pricing` D1 table (refreshed daily by the Worker cron —
 * live unit prices, fal's historical units, and our observed median
 * `unitsBilled`) over the baked-in `FAL_PRICING` seed. Endpoints with no row
 * yet (fresh deploy, brand-new model) estimate from the seed until the next
 * refresh. Billing never reads this — it uses fal's reported `unitsBilled`
 * at generation time.
 *
 * Cached per isolate for a few minutes: the gate runs on every generation
 * request and pricing moves at most daily.
 */

import { getDb } from '#db-client';
import type { EffectiveFalPricing } from '@/lib/ai/fal-cost';
import { FAL_PRICING } from '@/lib/ai/fal-pricing-data';
import { micros } from '@/lib/billing/money';
import { modelPricing } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

const CACHE_TTL_MS = 5 * 60 * 1000;

let cache: {
  at: number;
  map: Record<string, EffectiveFalPricing>;
} | null = null;

export async function getEffectiveFalPricing(): Promise<
  Record<string, EffectiveFalPricing>
> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.map;
  }

  const rows = await getDb()
    .select()
    .from(modelPricing)
    .where(eq(modelPricing.provider, 'fal'));

  const map: Record<string, EffectiveFalPricing> = { ...FAL_PRICING };
  for (const row of rows) {
    map[row.endpointId] = {
      unitPrice: micros(row.unitPriceMicros),
      unit: row.unit,
      typicalUnitsPerCall: row.typicalUnitsPerCall ?? undefined,
      observedMedianUnits: row.observedMedianUnits ?? undefined,
    };
  }

  cache = { at: Date.now(), map };
  return map;
}
