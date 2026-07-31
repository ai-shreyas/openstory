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

  // Grouped before merging: the table's key is (provider, endpointId, unit)
  // but this map is keyed by endpointId alone, so an endpoint mid-re-
  // denomination legitimately has two rows until the cron's stale sweep runs.
  const rowsByEndpoint = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = rowsByEndpoint.get(row.endpointId);
    if (list) list.push(row);
    else rowsByEndpoint.set(row.endpointId, [row]);
  }

  for (const [endpointId, endpointRows] of rowsByEndpoint) {
    if (endpointRows.length > 1) {
      // Billing multiplies unitsBilled by this price, so picking whichever row
      // sorted last is a wrong *charge*, not just a wrong estimate. Drop the
      // endpoint — including its seed entry — so it becomes a known unknown:
      // estimation gates on the floor and billing reports a $0 charge, both of
      // which are visible, where an arbitrary winner is silent.
      logger.error(
        'model_pricing has multiple rows for one endpoint — dropping it rather than billing an arbitrary rate',
        { endpointId, units: endpointRows.map((r) => r.unit) }
      );
      delete map[endpointId];
      continue;
    }
    const row = endpointRows[0];
    if (!row) continue;

    // Field-wise over the seed, NOT a wholesale replace, so a column the cron
    // has nothing for cannot erase a good seeded value (#1069/#1062).
    //
    // `typicalUnitsPerCall` is the exception: a *present row* with a null
    // there is the cron's answer that fal has no history for this endpoint —
    // it preserves the stored figure whenever a fetch merely failed. Falling
    // back to the seed here would resurrect the stale figure the cron
    // deliberately cleared, and no model fal stops reporting on could ever
    // shed it. An endpoint with no row at all still reads the seed, via the
    // `{ ...FAL_PRICING }` base above.
    const seed = FAL_PRICING[endpointId];
    map[endpointId] = {
      ...seed,
      unitPrice: micros(row.unitPriceMicros),
      unit: row.unit,
      typicalUnitsPerCall: row.typicalUnitsPerCall ?? undefined,
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
function warnIfStale(rows: { fetchedAt: Date; endpointId: string }[]): void {
  if (rows.length === 0) {
    // Not merely stale — the refresh has never landed a single row. Warn, not
    // error: local dev, e2e and every fresh deploy sit here legitimately until
    // the first nightly run, and this fires on every cache miss, so at error
    // level it would be mostly noise. The seed keeps estimates honest
    // meanwhile; it is the *stale* case below that means something is broken.
    logger.warn(
      'model_pricing is empty — estimating and billing from the static seed'
    );
    return;
  }
  // The OLDEST row, not the newest. Every row in a successful refresh is
  // stamped with the same `now`, so a lagging row means part of the write
  // failed — and the upserts are chunked and untransacted, so "chunk 3 of 4
  // throws every night" is a real shape. Keying off the newest row hides
  // exactly that: two fresh chunks would report a healthy table forever while
  // the rest sat frozen at last month's prices.
  const cutoff = Date.now() - STALE_AFTER_MS;
  const staleRows = rows.filter((row) => row.fetchedAt.getTime() < cutoff);
  if (staleRows.length === 0) return;
  const oldest = Math.min(...staleRows.map((row) => row.fetchedAt.getTime()));
  logger.error(
    'model_pricing is stale — the daily refresh cron has not run successfully',
    {
      staleRows: staleRows.length,
      totalRows: rows.length,
      partial: staleRows.length < rows.length,
      ageHours: Math.round((Date.now() - oldest) / 3_600_000),
      oldestFetchedAt: new Date(oldest).toISOString(),
      endpoints: staleRows.slice(0, 10).map((row) => row.endpointId),
    }
  );
}
