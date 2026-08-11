import { describe, expect, it } from 'vitest';
import { TEST_FAL_PRICING as FAL_PRICING } from '@/lib/ai/__tests__/fal-pricing-fixture';
import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import { SIGNUP_GRANT_MICROS } from '@/lib/billing/constants';
import { buildFilmCostExamples } from './film-cost-examples';
import { microsToUsd } from './money';

describe('buildFilmCostExamples', () => {
  it('returns null when the default image model has no pricing signal', () => {
    expect(buildFilmCostExamples({})).toBeNull();
  });

  it('builds three tiers with increasing cost', () => {
    const result = buildFilmCostExamples(FAL_PRICING);
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.examples).toHaveLength(3);
    const [images, motion, full] = result.examples;
    expect(images).toBeDefined();
    expect(motion).toBeDefined();
    expect(full).toBeDefined();
    if (!images || !motion || !full) return;

    expect(motion.costMicros).toBeGreaterThan(images.costMicros);
    expect(full.costMicros).toBeGreaterThan(motion.costMicros);
    expect(images.cost.startsWith('~')).toBe(true);
  });

  it('keeps the images-only tier within the welcome grant under fixture pricing', () => {
    const result = buildFilmCostExamples(FAL_PRICING);
    expect(result).not.toBeNull();
    if (!result) return;

    const imagesOnly = result.examples.find((e) => e.id === 'images-only');
    expect(imagesOnly).toBeDefined();
    if (!imagesOnly) return;

    expect(
      imagesOnly.costMicros,
      `images-only ($${microsToUsd(imagesOnly.costMicros).toFixed(2)} with ${DEFAULT_IMAGE_MODEL}) should fit in welcome grant ($${microsToUsd(SIGNUP_GRANT_MICROS)})`
    ).toBeLessThanOrEqual(SIGNUP_GRANT_MICROS);
  });
});
