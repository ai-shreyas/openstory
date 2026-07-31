/**
 * Guards for the fal pricing client (#1069).
 *
 * `unit` selects the entire estimation branch, so resolving it wrongly is off
 * by orders of magnitude rather than a little — and the failure is silent,
 * because a wrong-but-recognised unit produces a confident number. These tests
 * pin the two ways that happens: the substring order in `normalizeUnit`, and a
 * transient fal failure being mistaken for "fal says there is no history".
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchFalTypicalUnits,
  fetchFalUnitPrices,
} from '@/lib/ai/fal-pricing-fetch';

const PRICING_URL = 'https://api.fal.ai/v1/models/pricing';
const ESTIMATE_URL = 'https://api.fal.ai/v1/models/pricing/estimate';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(handler: (url: string) => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL) => Promise.resolve(handler(String(input))))
  );
}

/** One price row, with only the fields the client reads. */
function priceRow(overrides: {
  endpoint_id: string;
  unit: string;
  unit_price?: number;
}) {
  return { unit_price: 0.00167, currency: 'USD', ...overrides };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchFalUnitPrices', () => {
  it('resolves "compute seconds" to compute_seconds, not seconds', async () => {
    // The substring checks are ordered, and 'compute second' CONTAINS
    // 'second'. Swapping those two lines — a plausible reorder during a lint
    // or alphabetise pass — sends all seven compute-seconds endpoints down the
    // `seconds` branch, where `durationSeconds` is undefined for an image
    // generation and the estimate comes out $0.00 rather than null. $0 is not
    // null, so `gateEstimate` passes it straight through and the credit gate
    // clears every FLUX.2 / Grok Imagine generation for free.
    stubFetch(() =>
      json({
        prices: [
          priceRow({ endpoint_id: 'fal-ai/flux-2', unit: 'Compute Seconds' }),
        ],
      })
    );

    const prices = await fetchFalUnitPrices('key', ['fal-ai/flux-2']);
    expect(prices[0]?.unit).toBe('compute_seconds');
  });

  it('throws on the ambiguous "units" with no UNITS_KIND entry', async () => {
    // fal reports "units" for flat, per-image and per-1000-token alike. A
    // guess picks the wrong denominator; there is no safe default.
    stubFetch(() =>
      json({
        prices: [priceRow({ endpoint_id: 'fal-ai/not-tagged', unit: 'units' })],
      })
    );

    await expect(
      fetchFalUnitPrices('key', ['fal-ai/not-tagged'])
    ).rejects.toThrow(/UNITS_KIND/);
  });

  it('throws on an unrecognised unit rather than defaulting it', async () => {
    stubFetch(() =>
      json({
        prices: [priceRow({ endpoint_id: 'fal-ai/flux-2', unit: 'furlongs' })],
      })
    );

    await expect(fetchFalUnitPrices('key', ['fal-ai/flux-2'])).rejects.toThrow(
      /unrecognised unit/
    );
  });

  it('throws on a non-positive unit_price', async () => {
    // A 0 or null price reaches `unitPriceMicros` as 0/NaN, and every charge on
    // that endpoint silently becomes 0 — `falCostFromUnits` has no log of its
    // own for a zero price.
    stubFetch(() =>
      json({
        prices: [
          priceRow({
            endpoint_id: 'fal-ai/flux-2',
            unit: 'images',
            unit_price: 0,
          }),
        ],
      })
    );

    await expect(fetchFalUnitPrices('key', ['fal-ai/flux-2'])).rejects.toThrow(
      /non-positive unit_price/
    );
  });
});

describe('fetchFalTypicalUnits', () => {
  const price = {
    endpointId: 'fal-ai/flux-2',
    unitPriceUsd: 0.5,
    unit: 'images' as const,
  };

  it('reports an HTTP failure as failed, not as "no history"', async () => {
    // Collapsing the two nulls the stored typicalUnitsPerCall on one blip, and
    // gpt-image-2 then gates at $1.00/image instead of $0.22 (#1062).
    stubFetch((url) =>
      url === ESTIMATE_URL ? json({ error: 'boom' }, 500) : json({})
    );

    const { typicalUnits, failedEndpoints } = await fetchFalTypicalUnits(
      'key',
      [price]
    );
    expect(failedEndpoints.has('fal-ai/flux-2')).toBe(true);
    expect(typicalUnits.has('fal-ai/flux-2')).toBe(false);
  });

  it('retries a 429 rather than recording it as a failure', async () => {
    // Measured against the live API, fal 429s this endpoint after ~3 requests
    // even strictly sequential. Without a retry the refresh sits permanently
    // over MAX_TYPICAL_FETCH_FAILURE_RATIO and never records a single
    // typicalUnitsPerCall — the feature would be inert in production.
    vi.useFakeTimers();
    try {
      let calls = 0;
      stubFetch((url) => {
        if (url !== ESTIMATE_URL) return json({});
        calls++;
        return calls < 3
          ? json({ error: 'Too Many Requests' }, 429)
          : json({ total_cost: 0.11 });
      });

      const pending = fetchFalTypicalUnits('key', [price]);
      await vi.runAllTimersAsync();
      const { typicalUnits, failedEndpoints } = await pending;

      expect(calls).toBe(3);
      expect(failedEndpoints.size).toBe(0);
      expect(typicalUnits.get('fal-ai/flux-2')).toBeCloseTo(0.22, 6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after the retry budget and preserves stored data', async () => {
    vi.useFakeTimers();
    try {
      stubFetch((url) =>
        url === ESTIMATE_URL
          ? json({ error: 'Too Many Requests' }, 429)
          : json({})
      );

      const pending = fetchFalTypicalUnits('key', [price]);
      await vi.runAllTimersAsync();
      const { typicalUnits, failedEndpoints } = await pending;

      // `failed`, never `no-history` — the caller must keep what it has.
      expect(failedEndpoints.has('fal-ai/flux-2')).toBe(true);
      expect(typicalUnits.has('fal-ai/flux-2')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats an unparseable 200 body as failed instead of rejecting', async () => {
    // A CDN error page served as 200 text/html. Parsed outside the try, the
    // rejection escapes Promise.all and takes down every endpoint in the run,
    // defeating both this union and the caller's failure-ratio guard.
    stubFetch((url) =>
      url === ESTIMATE_URL
        ? new Response('<html>502</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          })
        : json({})
    );

    const { typicalUnits, failedEndpoints } = await fetchFalTypicalUnits(
      'key',
      [price]
    );
    expect(failedEndpoints.has('fal-ai/flux-2')).toBe(true);
    expect(typicalUnits.has('fal-ai/flux-2')).toBe(false);
  });

  it('converts a historical cost to units and leaves a no-history endpoint absent from both', async () => {
    stubFetch((url) =>
      url === ESTIMATE_URL ? json({ total_cost: 0.11 }) : json({})
    );
    const { typicalUnits, failedEndpoints } = await fetchFalTypicalUnits(
      'key',
      [price]
    );
    expect(typicalUnits.get('fal-ai/flux-2')).toBeCloseTo(0.22, 6);

    stubFetch((url) =>
      url === ESTIMATE_URL ? json({ total_cost: 0 }) : json({})
    );
    const zero = await fetchFalTypicalUnits('key', [price]);
    expect(zero.typicalUnits.has('fal-ai/flux-2')).toBe(false);
    expect(zero.failedEndpoints.has('fal-ai/flux-2')).toBe(false);
    expect(failedEndpoints.size).toBe(0);
  });
});

describe('the pricing URL is unchanged', () => {
  it('requests the endpoints it was asked about', async () => {
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      return json({
        prices: [priceRow({ endpoint_id: 'fal-ai/flux-2', unit: 'images' })],
      });
    });

    await fetchFalUnitPrices('key', ['fal-ai/flux-2']);
    expect(seen[0]?.startsWith(PRICING_URL)).toBe(true);
    expect(seen[0]).toContain('endpoint_id=fal-ai%2Fflux-2');
  });
});
