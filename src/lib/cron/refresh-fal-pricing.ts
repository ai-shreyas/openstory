/**
 * Daily fal pricing refresh (#1069).
 *
 * Driven by the Cloudflare Workers cron in `src/server.ts` (schedule in
 * `wrangler.jsonc` `triggers.crons`). Keeps the `model_pricing` D1 table —
 * the live source pre-flight estimation merges over the baked-in
 * `FAL_PRICING` seed — current from three signals:
 *
 * 1. fal's pricing API — per-unit price + unit kind, verbatim.
 * 2. fal's historical estimate — typical units per call (absent for every
 *    compute-seconds endpoint we use, the original #1069 bug). A failed
 *    fetch preserves the stored value rather than nulling it.
 * 3. `model_usage_observations` — median units per image from our own
 *    generations. The preferred estimation signal: it reflects our
 *    resolutions and prompts, and self-corrects as usage accumulates.
 *
 * Also appends a `model_pricing_history` row whenever an endpoint's unit
 * price changes (and on first sight), building a time-series of model costs.
 *
 * Both estimation AND billing read the resulting prices (`falCostFromUnits`
 * goes through `getEffectiveFalPricing`), so a fal price move reaches real
 * charges on the next refresh — hence the warn log on every change.
 */

import { getDb } from '#db-client';
import { getEnv } from '#env';
import { getFalEndpointIds } from '@/lib/ai/fal-endpoints';
import {
  fetchFalTypicalUnits,
  fetchFalUnitPrices,
} from '@/lib/ai/fal-pricing-fetch';
import { usdToMicros } from '@/lib/billing/money';
import {
  modelPricing,
  modelPricingHistory,
  modelUsageObservations,
} from '@/lib/db/schema';
import type { ObservedUnits } from '@/lib/db/schema/model-pricing';
import { getLogger } from '@/lib/observability/logger';
import { and, eq, lt, sql, type SQL } from 'drizzle-orm';

const logger = getLogger(['openstory', 'cron', 'refresh-fal-pricing']);

/**
 * Cron expression for this job — must match an entry in `wrangler.jsonc`
 * `triggers.crons` (default AND production blocks). `scheduled()` in
 * `src/server.ts` routes on it.
 */
export const FAL_PRICING_CRON = '17 3 * * *';

/** How far back observed unitsBilled samples count toward the median. */
const OBSERVATION_WINDOW_DAYS = 90;

/**
 * Samples per endpoint feeding the median, newest-first — so under heavy
 * volume the median reflects the most recent generations, and a busy endpoint
 * cannot crowd out a quiet one.
 */
const OBSERVATIONS_PER_ENDPOINT = 200;

/**
 * D1 caps a query at 100 bound params. Snapshot upserts bind 9 columns per
 * row and history inserts 6 (defaulted columns bind too) — chunk both.
 */
export const UPSERT_CHUNK = 10;
export const HISTORY_CHUNK = 15;

/**
 * Abort the refresh if more than this share of endpoints failed their
 * historical-estimate fetch. A handful of 429s is normal and handled by
 * preserving stored values; a broad failure (auth, outage) means the snapshot
 * we would write is mostly degraded, and yesterday's is strictly better.
 */
const MAX_TYPICAL_FETCH_FAILURE_RATIO = 0.25;

export type FalPricingRefreshSummary = {
  endpoints: number;
  priceChanges: number;
  observedEndpoints: number;
  observationSamples: number;
  prunedObservations: number;
};

/** Median of an unsorted list (mean of the middle pair for even lengths). */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  if (sorted.length % 2 === 1) return upper;
  return ((sorted[mid - 1] ?? 0) + upper) / 2;
}

/**
 * Observed units per fal endpoint. Values use the shared {@link ObservedUnits}
 * field names so the hand-off into the `model_pricing` row and out again into
 * `EffectiveFalPricing.observed` is a rename-free copy — with two locally-named
 * `number` fields, a mapping that swapped median and count would compile.
 */
type ObservedUnitsByEndpoint = Map<string, ObservedUnits>;

/**
 * The single method `computeObservedUnits` needs. Declared structurally rather
 * than as the full D1 client so the query can be exercised against a plain
 * libsql instance in tests — the bug this guards lives in drizzle's column
 * mapping, so a hand-rolled stub would reproduce nothing worth testing.
 */
type ObservationReader = {
  all<T>(query: SQL): Promise<T[]>;
};

/**
 * The `model_pricing` composite key, flattened for Map/Set lookup. The
 * separator is written as the `\u0000` escape, never a literal NUL byte —
 * an embedded NUL makes the whole source file binary to git (no diff, no
 * blame, invisible to grep).
 */
function pricingKey(row: { endpointId: string; unit: string }): string {
  return `${row.endpointId}\u0000${row.unit}`;
}

function observationCutoff(): Date {
  return new Date(Date.now() - OBSERVATION_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * `createdAt` is `integer({ mode: 'timestamp' })`, which drizzle stores in
 * **seconds**. Raw `sql` interpolation bypasses that mapping, so a `Date` or a
 * `getTime()` millisecond value compared against the column is always false —
 * silently, forever. Only the query builder's own operators (see the prune's
 * `lt(...)` below) apply the conversion for you.
 */
function toEpochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/**
 * Median observed units **per image** per fal endpoint, from the
 * `model_usage_observations` samples every fal generation records.
 *
 * `unitsBilled` is reported per fal *call*, and one call can render up to 4
 * images (`numImages`). The estimator multiplies its unit count back up by
 * `numImages`, so samples are divided down here — otherwise a 4-image call
 * would contribute a 4× sample and a later 4-image estimate would multiply it
 * again. Endpoints that don't take `numImages` record 1.
 *
 * The newest-first cap is applied **per endpoint** via a window function, not
 * as one global row limit: a global cap lets a high-volume model crowd out
 * every other one, starving exactly the rarely-used compute-seconds endpoints
 * that most need an observed median (#1069).
 */
export async function computeObservedUnits(
  db: ObservationReader
): Promise<{ observed: ObservedUnitsByEndpoint; samples: number }> {
  const cutoff = observationCutoff();
  const rows = await db.all<{
    endpoint_id: string;
    units_billed: number;
    num_images: number;
  }>(sql`
    SELECT endpoint_id, units_billed, num_images FROM (
      SELECT
        ${modelUsageObservations.endpointId} AS endpoint_id,
        ${modelUsageObservations.unitsBilled} AS units_billed,
        ${modelUsageObservations.numImages} AS num_images,
        ROW_NUMBER() OVER (
          PARTITION BY ${modelUsageObservations.endpointId}
          ORDER BY ${modelUsageObservations.createdAt} DESC
        ) AS rn
      FROM ${modelUsageObservations}
      WHERE ${modelUsageObservations.provider} = 'fal'
        AND ${modelUsageObservations.createdAt} > ${toEpochSeconds(cutoff)}
    ) WHERE rn <= ${OBSERVATIONS_PER_ENDPOINT}
  `);

  const byEndpoint = new Map<string, number[]>();
  for (const row of rows) {
    if (!Number.isFinite(row.units_billed) || row.units_billed <= 0) continue;
    const images =
      Number.isFinite(row.num_images) && row.num_images > 0
        ? row.num_images
        : 1;
    const perImage = row.units_billed / images;
    const list = byEndpoint.get(row.endpoint_id);
    if (list) list.push(perImage);
    else byEndpoint.set(row.endpoint_id, [perImage]);
  }

  const observed: ObservedUnitsByEndpoint = new Map();
  let samples = 0;
  for (const [endpointId, units] of byEndpoint) {
    observed.set(endpointId, {
      medianUnits: median(units),
      sampleCount: units.length,
    });
    samples += units.length;
  }
  return { observed, samples };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** Fetch fal pricing + our observed units and write snapshot + history. */
export async function refreshFalPricing(): Promise<FalPricingRefreshSummary> {
  const apiKey = getEnv().FAL_KEY;
  if (!apiKey) {
    throw new Error('refreshFalPricing: FAL_KEY is not configured');
  }

  const db = getDb();
  const endpoints = getFalEndpointIds();

  const unitPrices = await fetchFalUnitPrices(apiKey, endpoints);
  const { typicalUnits, failedEndpoints } = await fetchFalTypicalUnits(
    apiKey,
    unitPrices
  );

  if (
    unitPrices.length > 0 &&
    failedEndpoints.size / unitPrices.length > MAX_TYPICAL_FETCH_FAILURE_RATIO
  ) {
    throw new Error(
      `refreshFalPricing: ${failedEndpoints.size}/${unitPrices.length} historical ` +
        'estimate fetches failed — aborting rather than writing a degraded snapshot'
    );
  }

  const { observed, samples } = await computeObservedUnits(db);

  const existing = await db
    .select()
    .from(modelPricing)
    .where(eq(modelPricing.provider, 'fal'));
  const existingPriceByKey = new Map(
    existing.map((row) => [pricingKey(row), row.unitPriceMicros])
  );
  const existingTypicalByKey = new Map(
    existing.map((row) => [pricingKey(row), row.typicalUnitsPerCall])
  );

  const now = new Date();
  const snapshotRows = unitPrices.map((p) => {
    const obs = observed.get(p.endpointId);
    const key = pricingKey(p);
    // On a failed fetch, carry the stored value forward — absence of an answer
    // is not an answer of "none". A genuine no-history reply still nulls it,
    // so a model fal stops reporting on doesn't keep a stale figure forever.
    const typical =
      typicalUnits.get(p.endpointId) ??
      (failedEndpoints.has(p.endpointId)
        ? (existingTypicalByKey.get(key) ?? null)
        : null);
    return {
      provider: 'fal' as const,
      endpointId: p.endpointId,
      unit: p.unit,
      unitPriceMicros: usdToMicros(p.unitPriceUsd),
      typicalUnitsPerCall: typical,
      observedMedianUnits: obs?.medianUnits ?? null,
      observedSampleCount: obs?.sampleCount ?? 0,
      fetchedAt: now,
      updatedAt: now,
    };
  });

  // History: append on first sight or when the unit price moved.
  const historyRows = snapshotRows
    .filter(
      (row) => existingPriceByKey.get(pricingKey(row)) !== row.unitPriceMicros
    )
    .map((row) => ({
      provider: row.provider,
      endpointId: row.endpointId,
      unit: row.unit,
      unitPriceMicros: row.unitPriceMicros,
      recordedAt: now,
    }));

  for (const rows of chunk(historyRows, HISTORY_CHUNK)) {
    await db.insert(modelPricingHistory).values(rows);
  }

  // Billing multiplies unitsBilled by these prices, so a move here changes what
  // every team is charged from the next refresh onward. Say so loudly rather
  // than only appending a history row nobody reads.
  for (const row of historyRows) {
    const previous = existingPriceByKey.get(pricingKey(row));
    if (previous == null) continue; // first sight, not a change
    logger.warn('fal unit price changed — charges move with it', {
      endpointId: row.endpointId,
      unit: row.unit,
      fromMicros: previous,
      toMicros: row.unitPriceMicros,
    });
  }

  for (const rows of chunk(snapshotRows, UPSERT_CHUNK)) {
    await db
      .insert(modelPricing)
      .values(rows)
      .onConflictDoUpdate({
        target: [
          modelPricing.provider,
          modelPricing.endpointId,
          modelPricing.unit,
        ],
        set: {
          unitPriceMicros: sql`excluded.unit_price_micros`,
          typicalUnitsPerCall: sql`excluded.typical_units_per_call`,
          observedMedianUnits: sql`excluded.observed_median_units`,
          observedSampleCount: sql`excluded.observed_sample_count`,
          fetchedAt: sql`excluded.fetched_at`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }

  // An endpoint we no longer use (or that fal re-denominated to a different
  // unit) leaves a stale snapshot row on the old key — drop it so estimation
  // can't read a dead price.
  const freshKeys = new Set(snapshotRows.map((row) => pricingKey(row)));
  const staleRows = existing.filter((row) => !freshKeys.has(pricingKey(row)));
  for (const row of staleRows) {
    await db
      .delete(modelPricing)
      .where(
        and(
          eq(modelPricing.provider, 'fal'),
          eq(modelPricing.endpointId, row.endpointId),
          eq(modelPricing.unit, row.unit)
        )
      );
  }

  // Samples past the window can never feed a median again.
  const pruned = await db
    .delete(modelUsageObservations)
    .where(lt(modelUsageObservations.createdAt, observationCutoff()))
    .returning({ id: modelUsageObservations.id });

  const summary: FalPricingRefreshSummary = {
    prunedObservations: pruned.length,
    endpoints: snapshotRows.length,
    priceChanges: historyRows.length,
    observedEndpoints: observed.size,
    observationSamples: samples,
  };
  logger.info('fal pricing refresh complete', { ...summary });
  return summary;
}
