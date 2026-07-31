/**
 * Live fal pricing for pre-flight estimation (#1069).
 *
 * Merges the `model_pricing` D1 table (refreshed daily by the Worker cron —
 * live unit prices, fal's historical units, and our observed median
 * `unitsBilled`) over the baked-in `FAL_PRICING` seed. Endpoints with no row
 * yet (fresh deploy, brand-new model) estimate from the seed until the next
 * refresh. Billing reads this too (`falCostFromUnits`), so a fal price move
 * reaches the charge on the next refresh rather than waiting for someone to
 * re-run the generator.
 *
 * Cached per isolate for a few minutes: the gate runs on every generation
 * request and pricing moves at most daily.
 */

import { getDb } from '#db-client';
import type { EffectiveFalPricing } from '@/lib/ai/fal-cost';
import { FAL_PRICING } from '@/lib/ai/fal-pricing-data';
import { micros } from '@/lib/billing/money';
import { modelPricing } from '@/lib/db/schema';
import type { ObservedUnits } from '@/lib/db/schema/model-pricing';
import { getLogger } from '@/lib/observability/logger';
import { eq } from 'drizzle-orm';

const logger = getLogger(['openstory', 'ai', 'fal-pricing-live']);

const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * How stale the snapshot may get before we complain. The cron runs daily, so
 * anything past two missed runs means it is failing silently — and because a
 * stale table and a fresh one produce identical estimates, this log is the
 * only thing that can tell them apart (#1069).
 */
const STALE_AFTER_MS = 48 * 60 * 60 * 1000;

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
  // The table's key is (provider, endpointId, unit) but this map is keyed by
  // endpointId alone, so two rows for one endpoint — which is legitimate while
  // fal re-denominates a model, until the cron's stale sweep runs — would
  // collapse to whichever came last. Billing multiplies unitsBilled by that
  // price, so an arbitrary winner is a wrong charge. Say so.
  const seenEndpoints = new Set<string>();
  for (const row of rows) {
    if (seenEndpoints.has(row.endpointId)) {
      logger.error(
        'model_pricing has multiple rows for one endpoint — billing may use either rate',
        { endpointId: row.endpointId, unit: row.unit }
      );
    }
    seenEndpoints.add(row.endpointId);

    // Field-wise over the seed, NOT a wholesale replace. A null column means
    // "the cron has nothing for this field", which must not erase a good
    // seeded value — one transient fal 429 would otherwise drop
    // gpt-image-2's typicalUnitsPerCall and gate it at $1.00/image instead
    // of $0.22 until the next successful refresh (#1069/#1062).
    const seed = FAL_PRICING[row.endpointId];
    map[row.endpointId] = {
      ...seed,
      unitPrice: micros(row.unitPriceMicros),
      unit: row.unit,
      typicalUnitsPerCall: row.typicalUnitsPerCall ?? seed?.typicalUnitsPerCall,
      // The DB CHECK keeps median and count consistent, so a non-null median
      // always arrives with its real sample count.
      ...(row.observedMedianUnits != null && {
        observed: {
          medianUnits: row.observedMedianUnits,
          sampleCount: row.observedSampleCount,
        } satisfies ObservedUnits,
      }),
    };
  }

  warnIfStale(rows);
  cache = { at: Date.now(), map };
  return map;
}

/**
 * Complain once per cache fill when the snapshot can't be trusted — the cron
 * is broken, or nothing has ever run it. Both states estimate and bill from
 * the static seed while looking exactly like a healthy table, so these logs
 * are the only thing that distinguishes them.
 */
function warnIfStale(rows: { fetchedAt: Date }[]): void {
  if (rows.length === 0) {
    // Not merely stale — the refresh has never landed a single row. A fresh
    // deploy sits here legitimately until the first nightly run, which is
    // exactly the window worth knowing about.
    logger.error(
      'model_pricing is empty — estimating and billing from the static seed',
      { staleAfterHours: STALE_AFTER_MS / 3_600_000 }
    );
    return;
  }
  const newest = Math.max(...rows.map((row) => row.fetchedAt.getTime()));
  const ageMs = Date.now() - newest;
  if (ageMs <= STALE_AFTER_MS) return;
  logger.error(
    'model_pricing is stale — the daily refresh cron has not run successfully',
    {
      ageHours: Math.round(ageMs / 3_600_000),
      newestFetchedAt: new Date(newest).toISOString(),
      rows: rows.length,
    }
  );
}
