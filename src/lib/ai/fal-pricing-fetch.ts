/**
 * Fal pricing API client, shared by `scripts/update-fal-pricing.ts` (bakes the
 * static fallback file) and the daily Worker cron (`refresh-fal-pricing`)
 * that keeps the `model_pricing` D1 table live (#1069).
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

/**
 * Resolve fal's unit string to our billing denominator. **Throws** rather than
 * guessing: `unit` selects the entire estimation branch, so a wrong one is off
 * by orders of magnitude — defaulting an unrecognised unit to 'flat' would
 * estimate Grok Imagine at `unitPrice × 1` ≈ $0.00017 instead of ~$0.05, which
 * is #1069 restored (#1069 follow-up).
 *
 * This runs in an unattended nightly cron as well as the regen script, so a
 * `logger.warn` has no reader. Failing aborts the refresh and preserves
 * yesterday's correct snapshot, which beats writing a guess; in the script it
 * forces the `UNITS_KIND` entry to be added, which is the required action
 * either way.
 */
function normalizeUnit(apiUnit: string, endpointId: string): FalUnit {
  const u = apiUnit.toLowerCase();
  // The bare "units" is ambiguous (flat / per-image / per-1000-token all report
  // it), so it must be tagged in UNITS_KIND. Everything else is recognised by
  // substring so variants like "processed megapixels" still resolve.
  if (u === 'units') {
    const kind = UNITS_KIND[endpointId];
    if (!kind) {
      throw new Error(
        `fal pricing: ${endpointId} reports the ambiguous unit "units" with no ` +
          'UNITS_KIND entry. Add one in src/lib/ai/fal-pricing-fetch.ts — the ' +
          'billing denominator cannot be guessed.'
      );
    }
    return kind;
  }
  if (u.includes('megapixel')) return 'megapixels';
  if (u.includes('compute second')) return 'compute_seconds';
  if (u.includes('second')) return 'seconds';
  if (u.includes('minute')) return 'minutes';
  if (u.includes('image')) return 'images';
  throw new Error(
    `fal pricing: ${endpointId} reports unrecognised unit "${apiUnit}". Add a ` +
      'mapping in normalizeUnit (src/lib/ai/fal-pricing-fetch.ts).'
  );
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

  return data.prices.map((p) => {
    // `unit_price` is untyped JSON. A null or 0 flows through `usdToMicros`
    // into `unitPriceMicros` as NaN or 0, and `falCostFromUnits` then charges
    // `NaN`/`0` for every generation on that endpoint with no log of its own —
    // a silent free-generation switch. Refuse the snapshot instead.
    if (!Number.isFinite(p.unit_price) || p.unit_price <= 0) {
      throw new Error(
        `fal pricing API returned a non-positive unit_price for ${p.endpoint_id}: ${p.unit_price}`
      );
    }
    return {
      endpointId: p.endpoint_id,
      unitPriceUsd: p.unit_price,
      unit: normalizeUnit(p.unit, p.endpoint_id),
    };
  });
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

/**
 * Pacing for `/pricing/estimate`, which fal rate-limits far harder than
 * `/pricing`: measured against the live API, even strictly sequential requests
 * 800ms apart start returning 429 after the third. At the original 5-way
 * concurrency with a 150ms gap, ~28 of our 33 endpoints came back 429 on every
 * run — permanently over `MAX_TYPICAL_FETCH_FAILURE_RATIO`, so the refresh
 * could never record a single `typicalUnitsPerCall`.
 *
 * One at a time, ~1s apart, with backoff on 429. That is ~40s of wall clock
 * for the full endpoint list — irrelevant inside a nightly cron (which is
 * bounded by wall time, not CPU, and spends this waiting on fetch).
 */
const ESTIMATE_CONCURRENCY = 1;
const ESTIMATE_CHUNK_DELAY_MS = 1_000;
const ESTIMATE_MAX_ATTEMPTS = 4;
const ESTIMATE_BACKOFF_MS = 2_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Honour fal's `Retry-After` (seconds) when it sends one. */
function retryAfterMs(resp: Response, attempt: number): number {
  const header = Number(resp.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return header * 1000;
  return ESTIMATE_BACKOFF_MS * 2 ** (attempt - 1);
}

/**
 * "fal has no history for this endpoint" and "we failed to ask fal" look
 * identical downstream but must be handled oppositely: the first is a real
 * absence to record, the second must preserve whatever we already stored.
 * Collapsing them let one transient 429 null out good data permanently.
 */
type HistoricalCost =
  | { status: 'ok'; costUsd: number }
  | { status: 'no-history' }
  | { status: 'failed' };

async function fetchHistoricalCostUsd(
  apiKey: string,
  endpointId: string
): Promise<HistoricalCost> {
  for (let attempt = 1; attempt <= ESTIMATE_MAX_ATTEMPTS; attempt++) {
    let body: EstimateResponse;
    try {
      const resp = await fetch(
        'https://api.fal.ai/v1/models/pricing/estimate',
        {
          method: 'POST',
          headers: {
            Authorization: `Key ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            estimate_type: 'historical_api_price',
            endpoints: { [endpointId]: { call_quantity: 1 } },
          }),
        }
      );
      // 429 is the expected steady state here, not an anomaly — retry it.
      // Any other error status is a real failure worth preserving stored data.
      if (resp.status === 429 && attempt < ESTIMATE_MAX_ATTEMPTS) {
        await sleep(retryAfterMs(resp, attempt));
        continue;
      }
      if (!resp.ok) {
        logger.warn(
          `${endpointId}: historical estimate HTTP ${resp.status} — preserving stored typicalUnitsPerCall`
        );
        return { status: 'failed' };
      }
      // Inside the try: a 200 carrying HTML (a CDN error page, a proxy
      // interstitial) rejects here, and outside it that rejection escapes the
      // caller's loop and takes down every remaining endpoint — defeating both
      // this union and the caller's failure-ratio guard.
      body = await resp.json();
    } catch (error) {
      logger.warn(`${endpointId}: historical estimate request failed`, {
        err: error,
      });
      return { status: 'failed' };
    }
    if (!Number.isFinite(body.total_cost) || body.total_cost <= 0) {
      // fal answered and genuinely has no usage history (or the model is free).
      return { status: 'no-history' };
    }
    return { status: 'ok', costUsd: body.total_cost };
  }
  logger.warn(
    `${endpointId}: historical estimate still rate-limited after ${ESTIMATE_MAX_ATTEMPTS} attempts — preserving stored typicalUnitsPerCall`
  );
  return { status: 'failed' };
}

/** Stable precision for typical units (avoids float noise in diffs). */
function roundTypicalUnits(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

export type FalTypicalUnits = {
  /** Endpoints fal returned a usable historical cost for. */
  typicalUnits: Map<string, number>;
  /**
   * Endpoints we could not reach. Distinct from "absent from `typicalUnits`",
   * which also covers endpoints fal answered about but has no history for —
   * callers must preserve stored values for these rather than null them.
   */
  failedEndpoints: Set<string>;
};

/**
 * Fetch fal's historical per-call cost for each endpoint and convert it to a
 * typical unit count (cost / unit price). Endpoints fal has no usage history
 * for (total_cost 0 — true for every compute-seconds endpoint we use, six at
 * the time of writing, see #1069) are absent from `typicalUnits` and absent
 * from `failedEndpoints`.
 */
export async function fetchFalTypicalUnits(
  apiKey: string,
  unitPrices: FalUnitPrice[]
): Promise<FalTypicalUnits> {
  const typicalUnits = new Map<string, number>();
  const failedEndpoints = new Set<string>();
  for (let i = 0; i < unitPrices.length; i += ESTIMATE_CONCURRENCY) {
    const chunk = unitPrices.slice(i, i + ESTIMATE_CONCURRENCY);
    const costs = await Promise.all(
      chunk.map((p) => fetchHistoricalCostUsd(apiKey, p.endpointId))
    );
    for (let j = 0; j < chunk.length; j++) {
      const price = chunk[j];
      const cost = costs[j];
      if (price == null || cost == null) continue;
      if (cost.status === 'failed') {
        failedEndpoints.add(price.endpointId);
        continue;
      }
      // `fetchFalUnitPrices` guarantees a positive unitPriceUsd, so the only
      // remaining non-ok status is a genuine absence of history.
      if (cost.status === 'no-history') continue;
      typicalUnits.set(
        price.endpointId,
        roundTypicalUnits(cost.costUsd / price.unitPriceUsd)
      );
    }
    if (i + ESTIMATE_CONCURRENCY < unitPrices.length) {
      await new Promise((r) => setTimeout(r, ESTIMATE_CHUNK_DELAY_MS));
    }
  }
  return { typicalUnits, failedEndpoints };
}
