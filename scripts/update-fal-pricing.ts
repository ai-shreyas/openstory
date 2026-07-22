/**
 * Fetch live pricing from fal.ai and write src/lib/ai/fal-pricing-data.ts
 * Usage (Bun autoloads .env.local; use --env-file= to override):
 *   bun scripts/update-fal-pricing.ts
 *
 * The output is a flat map of `endpointId -> { unitPrice, unit, typicalUnitsPerCall? }`
 * taken from fal's pricing APIs:
 *
 * 1. GET /v1/models/pricing — unit_price + unit (billing denominator)
 * 2. POST /v1/models/pricing/estimate (historical_api_price) — typical cost
 *    per generation call, converted to typicalUnitsPerCall = cost / unit_price
 *
 * Actual credit deduction multiplies fal's reported `unitsBilled` by `unitPrice`
 * (see `falCostFromUnits` in `src/lib/ai/fal-cost.ts`). Pre-flight estimation
 * uses `typicalUnitsPerCall` for image/flat models so endpoints that report
 * ambiguous unit `"units"` with unit_price=$1 (e.g. openai/gpt-image-2) are
 * not treated as $1/image. Duration-based models still use parametric
 * estimates from request params.
 */
import { writeFile } from 'node:fs/promises';
import { getFalEndpointIds } from './fal-endpoints';
import { requireFalPricingKey } from './env-file';

/**
 * Wrapper to tag numeric values that should be serialized as `micros(X)` in the
 * generated output file.
 */
class MicrosValue {
  constructor(readonly value: number) {}
}

/** Convert USD to a MicrosValue for serialization tagging */
const m = (usd: number): MicrosValue =>
  new MicrosValue(Math.round(usd * 1_000_000));

type FalUnit =
  | 'images'
  | 'megapixels'
  | 'compute_seconds'
  | 'seconds'
  | 'minutes'
  | 'tokens'
  | 'flat';

type BuilderFalPricing = {
  unitPrice: MicrosValue;
  unit: FalUnit;
  /** From fal historical estimate; omitted when fal has no usable history. */
  typicalUnitsPerCall?: number;
};

const apiKey = requireFalPricingKey();

const endpoints = getFalEndpointIds();

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
      console.warn(
        `  ? ${endpointId}: unit "units" with no kind override — defaulting to 'flat' (estimation only)`
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
  console.warn(
    `  ? ${endpointId}: unknown unit "${apiUnit}" — defaulting to 'flat' (estimation only)`
  );
  return 'flat';
}

// ============================================================================
// Fetch unit pricing from API
// ============================================================================

const url = new URL('https://api.fal.ai/v1/models/pricing');
url.searchParams.set('endpoint_id', endpoints.join(','));

const response = await fetch(url.toString(), {
  headers: { Authorization: `Key ${apiKey}` },
});

if (!response.ok) {
  console.error(`HTTP ${response.status}: ${await response.text()}`);
  process.exit(1);
}

type PriceEntry = {
  endpoint_id: string;
  unit_price: number;
  unit: string;
  currency: string;
};

const data: { prices: PriceEntry[] } = await response.json();

// Check for missing endpoints
const found = new Set(data.prices.map((p) => p.endpoint_id));
const missing = endpoints.filter((e) => !found.has(e));
if (missing.length > 0) {
  console.error('\nERROR: Missing endpoints from fal pricing API:');
  for (const ep of missing) console.error(`  - ${ep}`);
  process.exit(1);
}

// ============================================================================
// Fetch historical per-call cost → typicalUnitsPerCall
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
    console.warn(
      `  ? ${endpointId}: historical estimate HTTP ${resp.status} — skipping typicalUnitsPerCall`
    );
    return null;
  }
  const body: EstimateResponse = await resp.json();
  if (!Number.isFinite(body.total_cost) || body.total_cost <= 0) {
    // No usage history (or free) — leave typicalUnitsPerCall unset so
    // estimateFalCost falls back to parametric unit math.
    return null;
  }
  return body.total_cost;
}

const historicalByEndpoint = new Map<string, number>();
for (let i = 0; i < endpoints.length; i += ESTIMATE_CONCURRENCY) {
  const chunk = endpoints.slice(i, i + ESTIMATE_CONCURRENCY);
  const costs = await Promise.all(chunk.map(fetchHistoricalCostUsd));
  for (let j = 0; j < chunk.length; j++) {
    const id = chunk[j];
    const cost = costs[j];
    if (id != null && cost != null) historicalByEndpoint.set(id, cost);
  }
  if (i + ESTIMATE_CONCURRENCY < endpoints.length) {
    await new Promise((r) => setTimeout(r, ESTIMATE_CHUNK_DELAY_MS));
  }
}

// ============================================================================
// Read existing file for a price-change diff
// ============================================================================

const outPath = new URL('../src/lib/ai/fal-pricing-data.ts', import.meta.url)
  .pathname;

let oldPricing: Record<
  string,
  { unitPrice?: number; typicalUnitsPerCall?: number }
> = {};
try {
  const existing = await import(outPath);
  oldPricing = existing.FAL_PRICING ?? {};
} catch {
  // First run — no existing file
}

// ============================================================================
// Build the flat pricing map (prices wrapped in MicrosValue for serialization)
// ============================================================================

/** Stable serialization precision for typical units (avoids float noise). */
function roundTypicalUnits(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

const pricing: Record<string, BuilderFalPricing> = {};
for (const p of data.prices.sort((a, b) =>
  a.endpoint_id.localeCompare(b.endpoint_id)
)) {
  const entry: BuilderFalPricing = {
    unitPrice: m(p.unit_price),
    unit: normalizeUnit(p.unit, p.endpoint_id),
  };

  const historicalUsd = historicalByEndpoint.get(p.endpoint_id);
  if (
    historicalUsd != null &&
    Number.isFinite(p.unit_price) &&
    p.unit_price > 0
  ) {
    entry.typicalUnitsPerCall = roundTypicalUnits(historicalUsd / p.unit_price);
  }

  pricing[p.endpoint_id] = entry;
}

// ============================================================================
// Log diff summary
// ============================================================================

let changes = 0;
for (const [id, entry] of Object.entries(pricing)) {
  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- Record lookup returns undefined for missing keys
  const old = oldPricing[id];
  const newPrice = entry.unitPrice.value;
  if (!old) {
    console.log(`  + ${id}: ${newPrice} micros (new)`);
    changes++;
  } else if (old.unitPrice !== newPrice) {
    console.log(`  ~ ${id}: ${old.unitPrice} → ${newPrice} micros`);
    changes++;
  }
  const newTypical = entry.typicalUnitsPerCall;
  const oldTypical = old?.typicalUnitsPerCall;
  if (newTypical !== oldTypical) {
    console.log(
      `  ~ ${id}: typicalUnitsPerCall ${oldTypical ?? '—'} → ${newTypical ?? '—'}`
    );
    changes++;
  }
  if (newTypical != null) {
    const estUsd = (newTypical * newPrice) / 1_000_000;
    console.log(
      `    hist ≈ $${estUsd.toFixed(4)}/call (${newTypical} units × $${(newPrice / 1_000_000).toFixed(6)})`
    );
  }
}
for (const id of Object.keys(oldPricing)) {
  if (!(id in pricing)) {
    console.log(`  - ${id}: removed`);
    changes++;
  }
}

// ============================================================================
// Write the generated file
// ============================================================================

/** Format large integers with underscore separators for readability */
function formatMicros(value: number): string {
  if (value === 0) return '0';
  const str = String(value);
  if (value >= 1000) {
    return str.replace(/\B(?=(\d{3})+(?!\d))/g, '_');
  }
  return str;
}

function formatTypicalUnitsLiteral(value: number): string {
  // Prefer short decimals when exact (0.22, 1.5); otherwise full rounded form.
  if (Number.isInteger(value)) return String(value);
  const asFixed = value.toFixed(6).replace(/\.?0+$/, '');
  return asFixed;
}

const entries = Object.entries(pricing)
  .map(([id, p]) => {
    const typical =
      p.typicalUnitsPerCall != null
        ? `, typicalUnitsPerCall: ${formatTypicalUnitsLiteral(p.typicalUnitsPerCall)}`
        : '';
    return `  '${id}': { unitPrice: micros(${formatMicros(p.unitPrice.value)}), unit: '${p.unit}'${typical} },`;
  })
  .join('\n');

const now = new Date().toISOString();
const output = `// AUTO-GENERATED — do not edit manually. Run: bun scripts/update-fal-pricing.ts
// The "units" disambiguation map is maintained in scripts/update-fal-pricing.ts

import { type Microdollars, micros } from '@/lib/billing/money';

// ============================================================================
// Fal Pricing (all prices in microdollars: 1 USD = 1,000,000)
//
// \`unitPrice\` is fal's per-unit price, taken verbatim from the pricing API.
// Actual cost = unitsBilled (from the adapter) * unitPrice. \`unit\` is the
// billed unit kind, used by pre-flight estimation when historical data is
// missing. \`typicalUnitsPerCall\` is fal's historical_api_price estimate
// converted to units (cost / unit_price) — preferred for image/flat preflight
// so models like openai/gpt-image-2 (unit_price=$1, ~0.22 units/call) are not
// estimated at $1/image.
// ============================================================================

export type FalUnit =
  | 'images'
  | 'megapixels'
  | 'compute_seconds'
  | 'seconds'
  | 'minutes'
  | 'tokens'
  | 'flat';

export type FalPricing = {
  unitPrice: Microdollars;
  unit: FalUnit;
  /**
   * Typical unitsBilled for one generation call, from fal historical estimate
   * (total_cost / unit_price). Preflight only — actual charges use the
   * unitsBilled fal reports on the completed request.
   */
  typicalUnitsPerCall?: number;
};

export const FAL_PRICING: Record<string, FalPricing> = {
${entries}
};

export const PRICING_LAST_UPDATED = '${now}';
`;

await writeFile(outPath, output);

console.log(
  `\nWrote ${Object.keys(pricing).length} endpoints to fal-pricing-data.ts (${changes} changes)`
);
console.log(
  `Historical estimates: ${historicalByEndpoint.size}/${endpoints.length} endpoints`
);
