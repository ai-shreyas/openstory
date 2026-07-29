/**
 * Fal pricing API client, shared by `scripts/update-fal-pricing.ts` (bakes the
 * static fallback file) and the daily Worker cron (`refresh-fal-pricing`)
 * that keeps the `fal_model_pricing` D1 table live (#1069).
 *
 * Two endpoints:
 * 1. GET /v1/models/pricing — unit_price + unit (billing denominator)
 * 2. POST /v1/models/pricing/estimate (historical_api_price) — fal's typical
 *    cost per generation call, converted to units (cost / unit_price)
 */
import type { FalUnit } from '@/lib/ai/fal-pricing-data';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'ai', 'fal-pricing-fetch']);

// ============================================================================
// "units" disambiguation
//
// The pricing API reports the ambiguous unit `"units"` for several distinct
// billing kinds (e.g. flat-per-video, per-1000-token, per-image, and per-second
// all show up as "units"). Tag the known ones so pre-flight ESTIMATION can
// predict a unit count when historical data is missing. This never affects an
// actual charge — billing always multiplies fal's reported `unitsBilled` by
// `unitPrice` regardless of `unit`.
// ============================================================================

const UNITS_KIND: Record<string, FalUnit> = {
  // Image models with unit "units": unit_price is the billable-unit size, not
  // a flat per-image dollar price. typicalUnitsPerCall (from historical) is
  // what makes preflight honest for these (e.g. gpt-image-2 ≈ 0.22 units).
  'openai/gpt-image-2': 'images',
  'openai/gpt-image-2/edit': 'images',
  'fal-ai/phota': 'images',
  'fal-ai/phota/edit': 'images',
  'fal-ai/ace-step-1.5': 'seconds',
  'fal-ai/minimax/hailuo-2.3/pro/image-to-video': 'flat',
  'bytedance/seedance-2.0/enterprise/v2/image-to-video': 'tokens',
  'bytedance/seedance-2.0/enterprise/v2/reference-to-video': 'tokens',
};

function normalizeUnit(apiUnit: string, endpointId: string): FalUnit {
  const u = apiUnit.toLowerCase();
  // The bare "units" is ambiguous (flat / per-image / per-1000-token all report
  // it), so it must be tagged in UNITS_KIND. Everything else is recognised by
  // substring so variants like "processed megapixels" still resolve.
  if (u === 'units') {
    const kind = UNITS_KIND[endpointId];
    if (!kind) {
      logger.warn(
        `${endpointId}: unit "units" with no kind override — defaulting to 'flat' (estimation only)`
      );
      return 'flat';
    }
    return kind;
  }
  if (u.includes('megapixel')) return 'megapixels';
  if (u.includes('compute second')) return 'compute_seconds';
  if (u.includes('second')) return 'seconds';
  if (u.includes('minute')) return 'minutes';
  if (u.includes('image')) return 'images';
  logger.warn(
    `${endpointId}: unknown unit "${apiUnit}" — defaulting to 'flat' (estimation only)`
  );
  return 'flat';
}

// ============================================================================
// Unit prices
// ============================================================================

export type FalUnitPrice = {
  endpointId: string;
  /** Per-unit price in USD, verbatim from the pricing API. */
  unitPriceUsd: number;
  unit: FalUnit;
};

type PriceEntry = {
  endpoint_id: string;
  unit_price: number;
  unit: string;
  currency: string;
};

/**
 * Fetch per-unit prices for the given endpoints. Throws when the API fails or
 * omits any requested endpoint — a silently missing price would make billing
 * for that model charge nothing.
 */
export async function fetchFalUnitPrices(
  apiKey: string,
  endpoints: string[]
): Promise<FalUnitPrice[]> {
  const url = new URL('https://api.fal.ai/v1/models/pricing');
  url.searchParams.set('endpoint_id', endpoints.join(','));

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Key ${apiKey}` },
  });
  if (!response.ok) {
    throw new Error(
      `fal pricing API HTTP ${response.status}: ${await response.text()}`
    );
  }

  const data: { prices: PriceEntry[] } = await response.json();
  const found = new Set(data.prices.map((p) => p.endpoint_id));
  const missing = endpoints.filter((e) => !found.has(e));
  if (missing.length > 0) {
    throw new Error(`fal pricing API missing endpoints: ${missing.join(', ')}`);
  }

  return data.prices.map((p) => ({
    endpointId: p.endpoint_id,
    unitPriceUsd: p.unit_price,
    unit: normalizeUnit(p.unit, p.endpoint_id),
  }));
}

// ============================================================================
// Historical per-call cost → typicalUnitsPerCall
//
// fal's estimate API only returns a single total_cost, so we request one
// endpoint at a time. Concurrency is kept low to avoid rate limits.
// ============================================================================

type EstimateResponse = {
  estimate_type: string;
  total_cost: number;
  currency: string;
};

const ESTIMATE_CONCURRENCY = 5;
const ESTIMATE_CHUNK_DELAY_MS = 150;

async function fetchHistoricalCostUsd(
  apiKey: string,
  endpointId: string
): Promise<number | null> {
  const resp = await fetch('https://api.fal.ai/v1/models/pricing/estimate', {
    method: 'POST',
    headers: {
      Authorization: `Key ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      estimate_type: 'historical_api_price',
      endpoints: { [endpointId]: { call_quantity: 1 } },
    }),
  });
  if (!resp.ok) {
    logger.warn(
      `${endpointId}: historical estimate HTTP ${resp.status} — skipping typicalUnitsPerCall`
    );
    return null;
  }
  const body: EstimateResponse = await resp.json();
  if (!Number.isFinite(body.total_cost) || body.total_cost <= 0) {
    // No usage history (or free) — caller leaves typicalUnitsPerCall unset.
    return null;
  }
  return body.total_cost;
}

/** Stable precision for typical units (avoids float noise in diffs). */
function roundTypicalUnits(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Fetch fal's historical per-call cost for each endpoint and convert it to a
 * typical unit count (cost / unit price). Endpoints with no usage history
 * (fal reports total_cost 0 — true for all six of our compute-seconds
 * endpoints, see #1069) are absent from the returned map.
 */
export async function fetchFalTypicalUnits(
  apiKey: string,
  unitPrices: FalUnitPrice[]
): Promise<Map<string, number>> {
  const typicalUnits = new Map<string, number>();
  for (let i = 0; i < unitPrices.length; i += ESTIMATE_CONCURRENCY) {
    const chunk = unitPrices.slice(i, i + ESTIMATE_CONCURRENCY);
    const costs = await Promise.all(
      chunk.map((p) => fetchHistoricalCostUsd(apiKey, p.endpointId))
    );
    for (let j = 0; j < chunk.length; j++) {
      const price = chunk[j];
      const costUsd = costs[j];
      if (price == null || costUsd == null || price.unitPriceUsd <= 0) continue;
      typicalUnits.set(
        price.endpointId,
        roundTypicalUnits(costUsd / price.unitPriceUsd)
      );
    }
    if (i + ESTIMATE_CONCURRENCY < unitPrices.length) {
      await new Promise((r) => setTimeout(r, ESTIMATE_CHUNK_DELAY_MS));
    }
  }
  return typicalUnits;
}
