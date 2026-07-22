// AUTO-GENERATED — do not edit manually. Run: bun scripts/update-fal-pricing.ts
// The "units" disambiguation map is maintained in scripts/update-fal-pricing.ts

import { type Microdollars, micros } from '@/lib/billing/money';

// ============================================================================
// Fal Pricing (all prices in microdollars: 1 USD = 1,000,000)
//
// `unitPrice` is fal's per-unit price, taken verbatim from the pricing API.
// Actual cost = unitsBilled (from the adapter) * unitPrice. `unit` is the
// billed unit kind, used by pre-flight estimation when historical data is
// missing. `typicalUnitsPerCall` is fal's historical_api_price estimate
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
  'bytedance/seedance-2.0/enterprise/v2/image-to-video': {
    unitPrice: micros(14_000),
    unit: 'tokens',
    typicalUnitsPerCall: 4.08,
  },
  'bytedance/seedance-2.0/enterprise/v2/reference-to-video': {
    unitPrice: micros(14_000),
    unit: 'tokens',
    typicalUnitsPerCall: 6.496429,
  },
  'fal-ai/ace-step-1.5': {
    unitPrice: micros(300),
    unit: 'seconds',
    typicalUnitsPerCall: 180,
  },
  'fal-ai/ace-step/prompt-to-audio': {
    unitPrice: micros(200),
    unit: 'seconds',
    typicalUnitsPerCall: 20,
  },
  'fal-ai/bytedance/seedream/v5/lite/edit': {
    unitPrice: micros(35_000),
    unit: 'images',
    typicalUnitsPerCall: 1,
  },
  'fal-ai/bytedance/seedream/v5/lite/text-to-image': {
    unitPrice: micros(35_000),
    unit: 'images',
    typicalUnitsPerCall: 1,
  },
  'fal-ai/elevenlabs/music': {
    unitPrice: micros(800_000),
    unit: 'minutes',
    typicalUnitsPerCall: 3,
  },
  'fal-ai/flux-2': { unitPrice: micros(1_670), unit: 'compute_seconds' },
  'fal-ai/flux-2-max': {
    unitPrice: micros(70_000),
    unit: 'megapixels',
    typicalUnitsPerCall: 1.428571,
  },
  'fal-ai/flux-2-max/edit': {
    unitPrice: micros(70_000),
    unit: 'megapixels',
    typicalUnitsPerCall: 4.001429,
  },
  'fal-ai/flux-2/edit': { unitPrice: micros(1_670), unit: 'compute_seconds' },
  'fal-ai/flux-2/turbo': {
    unitPrice: micros(8_000),
    unit: 'megapixels',
    typicalUnitsPerCall: 1,
  },
  'fal-ai/flux-2/turbo/edit': {
    unitPrice: micros(1_670),
    unit: 'compute_seconds',
  },
  'fal-ai/hidream-i1-full': {
    unitPrice: micros(50_000),
    unit: 'megapixels',
    typicalUnitsPerCall: 1,
  },
  'fal-ai/hunyuan-image/v3/instruct/edit': {
    unitPrice: micros(1_670),
    unit: 'compute_seconds',
  },
  'fal-ai/hunyuan-image/v3/text-to-image': {
    unitPrice: micros(100_000),
    unit: 'megapixels',
    typicalUnitsPerCall: 1,
  },
  'fal-ai/kling-video/v3/pro/image-to-video': {
    unitPrice: micros(140_000),
    unit: 'seconds',
    typicalUnitsPerCall: 12,
  },
  'fal-ai/ltx-2.3/image-to-video': {
    unitPrice: micros(80_000),
    unit: 'seconds',
    typicalUnitsPerCall: 12,
  },
  'fal-ai/minimax/hailuo-2.3/pro/image-to-video': {
    unitPrice: micros(490_000),
    unit: 'flat',
    typicalUnitsPerCall: 1,
  },
  'fal-ai/nano-banana-2': {
    unitPrice: micros(80_000),
    unit: 'images',
    typicalUnitsPerCall: 1.5,
  },
  'fal-ai/nano-banana-2/edit': {
    unitPrice: micros(80_000),
    unit: 'images',
    typicalUnitsPerCall: 1.5,
  },
  'fal-ai/nano-banana-pro': {
    unitPrice: micros(150_000),
    unit: 'images',
    typicalUnitsPerCall: 2,
  },
  'fal-ai/nano-banana-pro/edit': {
    unitPrice: micros(150_000),
    unit: 'images',
    typicalUnitsPerCall: 2,
  },
  'fal-ai/phota': {
    unitPrice: micros(90_000),
    unit: 'images',
    typicalUnitsPerCall: 2,
  },
  'fal-ai/phota/edit': {
    unitPrice: micros(90_000),
    unit: 'images',
    typicalUnitsPerCall: 3,
  },
  'fal-ai/qwen-image-2/pro/edit': {
    unitPrice: micros(75_000),
    unit: 'images',
    typicalUnitsPerCall: 1,
  },
  'fal-ai/qwen-image-2/pro/text-to-image': {
    unitPrice: micros(75_000),
    unit: 'images',
    typicalUnitsPerCall: 1,
  },
  'fal-ai/veo3.1/image-to-video': {
    unitPrice: micros(400_000),
    unit: 'seconds',
    typicalUnitsPerCall: 8,
  },
  'openai/gpt-image-2': {
    unitPrice: micros(1_000_000),
    unit: 'images',
    typicalUnitsPerCall: 0.22,
  },
  'openai/gpt-image-2/edit': {
    unitPrice: micros(1_000_000),
    unit: 'images',
    typicalUnitsPerCall: 0.22,
  },
  'xai/grok-imagine-image/quality/edit': {
    unitPrice: micros(170),
    unit: 'compute_seconds',
  },
  'xai/grok-imagine-image/quality/text-to-image': {
    unitPrice: micros(170),
    unit: 'compute_seconds',
  },
  'xai/grok-imagine-video/v1.5/image-to-video': {
    unitPrice: micros(10_000),
    unit: 'seconds',
  },
};

export const PRICING_LAST_UPDATED = '2026-07-22T08:25:50.090Z';
