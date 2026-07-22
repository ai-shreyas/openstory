import { describe, expect, test } from 'vitest';
import { estimateFalCost, falCostFromUnits } from './fal-cost';
import { FAL_PRICING } from './fal-pricing-data';
import {
  AUDIO_MODELS,
  EDIT_ENDPOINTS,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
  MOTION_REFERENCE_ENDPOINTS,
} from '@/lib/ai/models';
import { micros, usdToMicros, ZERO_MICROS } from '@/lib/billing/money';

const usd = (n: number) => usdToMicros(n);

describe('falCostFromUnits', () => {
  test('per-image: unitsBilled * unitPrice (resolution premium is in the count)', () => {
    // nano-banana-2 = $0.08/image. A 2K image fal bills as 1.5 units.
    expect(falCostFromUnits('fal-ai/nano-banana-2', 1)).toBe(micros(80_000));
    expect(falCostFromUnits('fal-ai/nano-banana-2', 1.5)).toBe(micros(120_000));
  });

  test('per-megapixel: fractional units', () => {
    // flux-2-max = $0.07/megapixel.
    expect(falCostFromUnits('fal-ai/flux-2-max', 1.05)).toBe(micros(73_500));
  });

  test('flat: hailuo bills 1 unit at $0.49', () => {
    expect(
      falCostFromUnits('fal-ai/minimax/hailuo-2.3/pro/image-to-video', 1)
    ).toBe(usd(0.49));
  });

  test('per-token: seedance bills 1000-token units at $0.014', () => {
    expect(
      falCostFromUnits(
        'bytedance/seedance-2.0/enterprise/v2/image-to-video',
        108
      )
    ).toBe(micros(1_512_000));
  });

  test('audio per-minute: elevenlabs bills 1 unit at $0.80', () => {
    expect(falCostFromUnits('fal-ai/elevenlabs/music', 1)).toBe(usd(0.8));
  });

  test('missing unitsBilled charges nothing', () => {
    expect(falCostFromUnits('fal-ai/nano-banana-2', undefined)).toBe(
      ZERO_MICROS
    );
  });

  test('unknown endpoint charges nothing', () => {
    expect(falCostFromUnits('unknown/model', 5)).toBe(ZERO_MICROS);
  });
});

describe('estimateFalCost', () => {
  test('per-image uses typicalUnitsPerCall × numImages (nano-banana historical 1.5×)', () => {
    // unitPrice $0.08, typicalUnitsPerCall 1.5 → $0.12 each, $0.24 for 2.
    expect(estimateFalCost('fal-ai/nano-banana-2', { numImages: 2 })).toBe(
      micros(240_000)
    );
  });

  test('gpt-image-2 is not estimated at $1/image (unit_price is $1 per unit, ~0.22 units/call)', () => {
    // fal historical_api_price ≈ $0.22/call; unit_price=$1 → 0.22 units.
    // Treating unitPrice as a flat per-image dollar cost was the #1062 bug.
    expect(estimateFalCost('openai/gpt-image-2', { numImages: 1 })).toBe(
      micros(220_000)
    );
    expect(estimateFalCost('openai/gpt-image-2', { numImages: 14 })).toBe(
      micros(3_080_000)
    );
    // Must stay well under the $1×N overestimate that blocked first storyboards.
    expect(
      Number(estimateFalCost('openai/gpt-image-2', { numImages: 1 }))
    ).toBeLessThan(Number(usd(1)));
  });

  test('per-second scales by duration (ignores historical typical duration)', () => {
    expect(
      estimateFalCost('fal-ai/veo3.1/image-to-video', { durationSeconds: 8 })
    ).toBe(usd(3.2));
  });

  test('per-minute rounds up', () => {
    expect(
      estimateFalCost('fal-ai/elevenlabs/music', { durationSeconds: 61 })
    ).toBe(usd(1.6));
  });

  test('compute-seconds uses a fixed estimate when historical is absent', () => {
    // grok-imagine-image = $0.00017/compute-second, 3s default * 2 images.
    // fal historical is $0 for this endpoint, so typicalUnitsPerCall is omitted.
    expect(
      estimateFalCost('xai/grok-imagine-image/quality/text-to-image', {
        numImages: 2,
      })
    ).toBe(micros(1_020));
  });

  test('tokens estimate from resolution (parametric, not historical)', () => {
    expect(
      estimateFalCost('bytedance/seedance-2.0/enterprise/v2/image-to-video', {
        durationSeconds: 5,
        resolution: '720p',
      })
    ).toBe(micros(1_587_600));
  });

  test('unknown endpoint estimates nothing', () => {
    expect(estimateFalCost('unknown/model', { numImages: 1 })).toBe(
      ZERO_MICROS
    );
  });
});
describe('FAL_PRICING coverage', () => {
  // Every model we can generate with must have pricing, or it bills $0 at
  // runtime (a loud error, but only after free generations). This turns a
  // missing entry — e.g. after a model bump — into a pre-merge failure.
  const endpointIds = [
    ...Object.values(IMAGE_MODELS).map((m) => m.id),
    ...Object.values(IMAGE_TO_VIDEO_MODELS).map((m) => m.id),
    ...Object.values(AUDIO_MODELS).map((m) => m.id),
    ...Object.values(EDIT_ENDPOINTS).filter((id): id is string => !!id),
    ...Object.values(MOTION_REFERENCE_ENDPOINTS).map((m) => m.endpointId),
  ];

  test.each([...new Set(endpointIds)])('has pricing for %s', (id) => {
    expect(FAL_PRICING[id]).toBeDefined();
  });

  test('gpt-image-2 carries a sub-1 typicalUnitsPerCall from fal historical', () => {
    // Guards the regression where unit_price=$1 was treated as $1/image.
    const pricing = FAL_PRICING['openai/gpt-image-2'];
    expect(pricing?.unitPrice).toBe(micros(1_000_000));
    const typical = pricing?.typicalUnitsPerCall;
    expect(typical).toBeDefined();
    expect(typical ?? 0).toBeGreaterThan(0);
    expect(typical ?? 1).toBeLessThan(1);
  });
});
