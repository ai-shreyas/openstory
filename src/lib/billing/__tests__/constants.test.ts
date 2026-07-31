import { DEFAULT_ASPECT_RATIO } from '@/lib/constants/aspect-ratios';
import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import { describe, expect, it } from 'vitest';
import { FAL_PRICING } from '@/lib/ai/fal-pricing-data';
import {
  SIGNUP_GRANT_MICROS,
  formatProcessingFeePercent,
  processingFeeUsd,
  splitCheckoutAmounts,
  totalCheckoutCents,
  totalCheckoutUsd,
} from '../constants';
import { estimateStoryboardCost } from '../cost-estimation';
import { micros, microsToUsd, usdToMicros } from '../money';

describe('billing constants', () => {
  it('applies processing fee only at purchase', () => {
    expect(processingFeeUsd(100)).toBe(5);
    expect(totalCheckoutUsd(100)).toBe(105);
    expect(formatProcessingFeePercent()).toBe('5%');
  });

  it('splits checkout into credit and fee line items', () => {
    expect(splitCheckoutAmounts(100)).toEqual({
      creditUsd: 100,
      feeUsd: 5,
      totalUsd: 105,
    });
  });

  it('rounds fee to cents for Stripe', () => {
    expect(splitCheckoutAmounts(10)).toEqual({
      creditUsd: 10,
      feeUsd: 0.5,
      totalUsd: 10.5,
    });
  });

  it('rounds fee from credit cents, not float USD', () => {
    expect(splitCheckoutAmounts(10.01)).toEqual({
      creditUsd: 10.01,
      feeUsd: 0.5,
      totalUsd: 10.51,
    });
  });

  it('totalCheckoutCents returns integer cents aligned with splitCheckoutAmounts', () => {
    expect(totalCheckoutCents(usdToMicros(100))).toBe(10_500);
    expect(totalCheckoutCents(usdToMicros(10))).toBe(1_050);
    expect(totalCheckoutCents(micros(10_500_000))).toBe(1_103);
    expect(Number.isInteger(totalCheckoutCents(micros(10_010_000)))).toBe(true);
  });

  /**
   * #1062: new users must be able to generate a storyboard on first try with
   * product defaults (DEFAULT_IMAGE_MODEL, images only — motion/music off).
   * If this fails, either raise SIGNUP_GRANT_USD or re-check default model
   * pricing / storyboard cost assumptions.
   */
  it('signup grant covers a default storyboard pre-flight estimate', () => {
    const defaultStoryboardCost = estimateStoryboardCost({
      imageModel: DEFAULT_IMAGE_MODEL,
      aspectRatio: DEFAULT_ASPECT_RATIO,
      pricing: FAL_PRICING,
    });

    expect(
      SIGNUP_GRANT_MICROS,
      `SIGNUP_GRANT ($${microsToUsd(SIGNUP_GRANT_MICROS)}) must be ≥ default storyboard estimate ($${microsToUsd(defaultStoryboardCost).toFixed(2)} with ${DEFAULT_IMAGE_MODEL})`
    ).toBeGreaterThanOrEqual(defaultStoryboardCost);
  });
});
