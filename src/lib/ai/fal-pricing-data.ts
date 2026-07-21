// AUTO-GENERATED — do not edit manually. Run: bun scripts/update-fal-pricing.ts
// The "units" disambiguation map is maintained in scripts/update-fal-pricing.ts

import { type Microdollars, micros } from '@/lib/billing/money';

// ============================================================================
// Fal Pricing (all prices in microdollars: 1 USD = 1,000,000)
//
// `unitPrice` is fal's per-unit price, taken verbatim from the pricing API.
// Actual cost = unitsBilled (from the adapter) * unitPrice. `unit` is the
// billed unit, used only by pre-flight cost estimation.
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
};

export const FAL_PRICING: Record<string, FalPricing> = {
  'bytedance/seedance-2.0/enterprise/v2/image-to-video': {
    unitPrice: micros(14_000),
    unit: 'tokens',
  },
  'bytedance/seedance-2.0/enterprise/v2/reference-to-video': {
    unitPrice: micros(14_000),
    unit: 'tokens',
  },
  'fal-ai/ace-step-1.5': { unitPrice: micros(300), unit: 'seconds' },
  'fal-ai/ace-step/prompt-to-audio': {
    unitPrice: micros(200),
    unit: 'seconds',
  },
  'fal-ai/bytedance/seedream/v5/lite/edit': {
    unitPrice: micros(35_000),
    unit: 'images',
  },
  'fal-ai/bytedance/seedream/v5/lite/text-to-image': {
    unitPrice: micros(35_000),
    unit: 'images',
  },
  'fal-ai/elevenlabs/music': { unitPrice: micros(800_000), unit: 'minutes' },
  'fal-ai/flux-2': { unitPrice: micros(1_670), unit: 'compute_seconds' },
  'fal-ai/flux-2-max': { unitPrice: micros(70_000), unit: 'megapixels' },
  'fal-ai/flux-2-max/edit': { unitPrice: micros(70_000), unit: 'megapixels' },
  'fal-ai/flux-2/edit': { unitPrice: micros(1_670), unit: 'compute_seconds' },
  'fal-ai/flux-2/turbo': { unitPrice: micros(8_000), unit: 'megapixels' },
  'fal-ai/flux-2/turbo/edit': {
    unitPrice: micros(1_670),
    unit: 'compute_seconds',
  },
  'fal-ai/hidream-i1-full': { unitPrice: micros(50_000), unit: 'megapixels' },
  'fal-ai/hunyuan-image/v3/instruct/edit': {
    unitPrice: micros(1_670),
    unit: 'compute_seconds',
  },
  'fal-ai/hunyuan-image/v3/text-to-image': {
    unitPrice: micros(100_000),
    unit: 'megapixels',
  },
  'fal-ai/kling-video/v3/pro/image-to-video': {
    unitPrice: micros(140_000),
    unit: 'seconds',
  },
  'fal-ai/ltx-2.3/image-to-video': {
    unitPrice: micros(80_000),
    unit: 'seconds',
  },
  'fal-ai/minimax/hailuo-2.3/pro/image-to-video': {
    unitPrice: micros(490_000),
    unit: 'flat',
  },
  'fal-ai/nano-banana-2': { unitPrice: micros(80_000), unit: 'images' },
  'fal-ai/nano-banana-2/edit': { unitPrice: micros(80_000), unit: 'images' },
  'fal-ai/nano-banana-pro': { unitPrice: micros(150_000), unit: 'images' },
  'fal-ai/nano-banana-pro/edit': { unitPrice: micros(150_000), unit: 'images' },
  'fal-ai/phota': { unitPrice: micros(90_000), unit: 'images' },
  'fal-ai/phota/edit': { unitPrice: micros(90_000), unit: 'images' },
  'fal-ai/qwen-image-2/pro/edit': { unitPrice: micros(75_000), unit: 'images' },
  'fal-ai/qwen-image-2/pro/text-to-image': {
    unitPrice: micros(75_000),
    unit: 'images',
  },
  'fal-ai/veo3.1/image-to-video': {
    unitPrice: micros(400_000),
    unit: 'seconds',
  },
  'openai/gpt-image-2': { unitPrice: micros(1_000_000), unit: 'images' },
  'openai/gpt-image-2/edit': { unitPrice: micros(1_000_000), unit: 'images' },
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

export const PRICING_LAST_UPDATED = '2026-06-18T02:03:11.319Z';
