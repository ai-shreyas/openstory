/**
 * Fetch live pricing from fal.ai and write src/lib/ai/fal-pricing-data.ts
 * Usage (Bun autoloads .env.local; use --env-file= to override):
 *   bun scripts/update-fal-pricing.ts
 *
 * The output is a flat map of `endpointId -> { unitPrice, unit, typicalUnitsPerCall? }`
 * taken from fal's pricing APIs (see src/lib/ai/fal-pricing-fetch.ts, shared
 * with the daily Worker cron that keeps the `fal_model_pricing` D1 table
 * live — the baked file is the fallback seed for endpoints with no row yet).
 *
 * Actual credit deduction multiplies fal's reported `unitsBilled` by `unitPrice`
 * (see `falCostFromUnits` in `src/lib/ai/fal-cost.ts`). Pre-flight estimation
 * uses observed median units from our own generations first, then
 * `typicalUnitsPerCall` (fal's historical estimate), so endpoints that report
 * ambiguous unit `"units"` with unit_price=$1 (e.g. openai/gpt-image-2) are
 * not treated as $1/image. Duration-based models still use parametric
 * estimates from request params.
 */
import { writeFile } from 'node:fs/promises';
import { getFalEndpointIds } from '@/lib/ai/fal-endpoints';
import {
  fetchFalTypicalUnits,
  fetchFalUnitPrices,
  type FalUnitPrice,
} from '@/lib/ai/fal-pricing-fetch';
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

type BuilderFalPricing = {
  unitPrice: MicrosValue;
  unit: FalUnitPrice['unit'];
  /** From fal historical estimate; omitted when fal has no usable history. */
  typicalUnitsPerCall?: number;
};

const apiKey = requireFalPricingKey();

const endpoints = getFalEndpointIds();

const unitPrices = await fetchFalUnitPrices(apiKey, endpoints);
const typicalUnits = await fetchFalTypicalUnits(apiKey, unitPrices);

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

const pricing: Record<string, BuilderFalPricing> = {};
for (const p of unitPrices.sort((a, b) =>
  a.endpointId.localeCompare(b.endpointId)
)) {
  const entry: BuilderFalPricing = {
    unitPrice: m(p.unitPriceUsd),
    unit: p.unit,
  };

  const typical = typicalUnits.get(p.endpointId);
  if (typical != null) {
    entry.typicalUnitsPerCall = typical;
  }

  pricing[p.endpointId] = entry;
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
// The "units" disambiguation map is maintained in src/lib/ai/fal-pricing-fetch.ts

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
//
// This file is the STATIC FALLBACK SEED. At runtime the \`fal_model_pricing\`
// D1 table (refreshed daily by the Worker cron, #1069) overrides these values
// and adds observed median units from our own generations.
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
  `Historical estimates: ${typicalUnits.size}/${endpoints.length} endpoints`
);
