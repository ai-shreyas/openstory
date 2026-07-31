/**
 * Guards for the seed merge (#1069).
 *
 * `getEffectiveFalPricing` layers `model_pricing` rows over the baked-in
 * `FAL_PRICING` seed **field by field**. A wholesale replace would let one
 * null column erase a good seeded value — a single transient fal 429 leaves
 * `typicalUnitsPerCall` null for an endpoint, and gpt-image-2 would then gate
 * at its $1.00 unit price instead of the ~$0.22 an image actually bills
 * (#1062). Both shapes typecheck and neither logs, so only a test tells them
 * apart.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FAL_PRICING } from '@/lib/ai/fal-pricing-data';
import { micros } from '@/lib/billing/money';

type Row = {
  provider: string;
  endpointId: string;
  unit: string;
  unitPriceMicros: number;
  typicalUnitsPerCall: number | null;
  observedMedianUnits: number | null;
  observedSampleCount: number;
  fetchedAt: Date;
  updatedAt: Date;
};

function row(overrides: Partial<Row> & Pick<Row, 'endpointId'>): Row {
  return {
    provider: 'fal',
    unit: 'images',
    unitPriceMicros: 1_000_000,
    typicalUnitsPerCall: null,
    observedMedianUnits: null,
    observedSampleCount: 0,
    fetchedAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** Stubs the one query shape `getEffectiveFalPricing` issues. */
async function loadWithRows(rows: Row[]) {
  vi.resetModules(); // the module caches its map per isolate
  vi.doMock('#db-client', () => ({
    getDb: () => ({
      select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
    }),
  }));
  return await import('@/lib/ai/fal-pricing-live');
}

describe('getEffectiveFalPricing', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('keeps the seeded typicalUnitsPerCall when the column is null', async () => {
    const seeded = FAL_PRICING['openai/gpt-image-2']?.typicalUnitsPerCall;
    expect(seeded).toBeGreaterThan(0); // guard the fixture, not the code

    const { getEffectiveFalPricing } = await loadWithRows([
      row({ endpointId: 'openai/gpt-image-2', typicalUnitsPerCall: null }),
    ]);

    const merged = (await getEffectiveFalPricing())['openai/gpt-image-2'];
    expect(merged?.typicalUnitsPerCall).toBe(seeded);
  });

  it('takes the live unit price over the seed', async () => {
    const { getEffectiveFalPricing } = await loadWithRows([
      row({ endpointId: 'openai/gpt-image-2', unitPriceMicros: 2_500_000 }),
    ]);

    const merged = (await getEffectiveFalPricing())['openai/gpt-image-2'];
    expect(merged?.unitPrice).toBe(micros(2_500_000));
  });

  it('omits `observed` entirely when there is no median', async () => {
    // An `observed` present with a null median would put the burden of
    // rejecting it on isUsableCount, one `??` away from a $0 gate.
    const { getEffectiveFalPricing } = await loadWithRows([
      row({
        endpointId: 'openai/gpt-image-2',
        observedMedianUnits: null,
        observedSampleCount: 12,
      }),
    ]);

    const merged = (await getEffectiveFalPricing())['openai/gpt-image-2'];
    expect(merged?.observed).toBeUndefined();
  });

  it('carries the median and its sample count together', async () => {
    const { getEffectiveFalPricing } = await loadWithRows([
      row({
        endpointId: 'xai/grok-imagine',
        unit: 'compute_seconds',
        observedMedianUnits: 294,
        observedSampleCount: 7,
      }),
    ]);

    const merged = (await getEffectiveFalPricing())['xai/grok-imagine'];
    expect(merged?.observed).toEqual({ medianUnits: 294, sampleCount: 7 });
  });

  it('falls back to the seed for endpoints with no row yet', async () => {
    const { getEffectiveFalPricing } = await loadWithRows([]);

    const map = await getEffectiveFalPricing();
    expect(map['openai/gpt-image-2']?.typicalUnitsPerCall).toBe(
      FAL_PRICING['openai/gpt-image-2']?.typicalUnitsPerCall
    );
  });
});
