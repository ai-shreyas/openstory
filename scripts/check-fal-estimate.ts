/**
 * Check per-call cost estimates from fal's historical pricing
 * Uses the Estimate Cost API (POST /v1/models/pricing/estimate)
 *
 * Note: the --individual flag hits the API once per model and may get rate-limited.
 *
 * Usage (Bun autoloads .env.local; use --env-file= to override):
 *   bun scripts/check-fal-estimate.ts              # Total estimate
 *   bun scripts/check-fal-estimate.ts --individual  # Per-model breakdown
 */
import { getFalEndpointIds } from '@/lib/ai/fal-endpoints';
import { requireFalPricingKey } from './env-file';

const allIds = getFalEndpointIds();
const apiKey = requireFalPricingKey();

type EstimateResponse = {
  estimate_type: string;
  total_cost: number;
  currency: string;
};

function estimateFetch(
  endpoints: Record<string, { call_quantity: number }>
): Promise<Response> {
  return fetch('https://api.fal.ai/v1/models/pricing/estimate', {
    method: 'POST',
    headers: {
      Authorization: `Key ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ estimate_type: 'historical_api_price', endpoints }),
  });
}

// Batch all in one request to avoid rate limits
const endpoints = Object.fromEntries(
  allIds.map((id) => [id, { call_quantity: 1 }])
);

const response = await estimateFetch(endpoints);
if (!response.ok) {
  console.error(`HTTP ${response.status}: ${await response.text()}`);
  process.exit(1);
}

const estimate: EstimateResponse = await response.json();

console.log(
  `\nTotal estimate (1 call each, ${allIds.length} models): $${estimate.total_cost} ${estimate.currency}`
);
console.log(
  `Average per model: $${(estimate.total_cost / allIds.length).toFixed(4)}`
);

// Individual estimates (one request per model to get per-model breakdown)
// WARNING: will hit rate limits if you have many models. Use sparingly.
if (process.argv.includes('--individual')) {
  console.log('\nPer-model estimates (1 call each):');
  for (const id of allIds) {
    const resp = await estimateFetch({ [id]: { call_quantity: 1 } });
    if (!resp.ok) {
      console.log(`  ${id}: ERROR ${resp.status} (rate limited?)`);
      break;
    }
    const data: EstimateResponse = await resp.json();
    console.log(`  ${id}: $${data.total_cost} ${data.currency}`);
    // Small delay to avoid rate limits
    await new Promise((r) => setTimeout(r, 200));
  }
}
