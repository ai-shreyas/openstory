/**
 * Check fal.ai pricing for all supported models
 * Usage: bun scripts/check-fal-pricing.ts
 * (Bun autoloads .env.local; use --env-file= to override)
 */
import { getFalEndpointIds } from '@/lib/ai/fal-endpoints';
import { requireFalPricingKey } from './env-file';

const endpoints = getFalEndpointIds();
const apiKey = requireFalPricingKey();

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

console.log('\nendpoint_id | unit_price | unit | currency');
console.log('--- | --- | --- | ---');
for (const p of data.prices) {
  console.log(`${p.endpoint_id} | ${p.unit_price} | ${p.unit} | ${p.currency}`);
}

const found = new Set(data.prices.map((p) => p.endpoint_id));
const missing = endpoints.filter((e) => !found.has(e));
if (missing.length > 0) {
  console.log('\nMISSING from pricing API:');
  for (const m of missing) console.log(`  - ${m}`);
}
