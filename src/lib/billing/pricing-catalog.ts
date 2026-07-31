/**
 * Public model pricing catalog — single source for the /pricing page.
 * Combines live fal pricing (`model_pricing`, passed in by the server
 * function) with OpenRouter LLM token rates.
 */

import type { EffectiveFalPricing } from '@/lib/ai/fal-pricing-live';
import { estimateStrategy, knownUnitsPerCall } from '@/lib/ai/fal-cost';
import {
  AUDIO_MODELS,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
} from '@/lib/ai/models';
import { SCRIPT_ANALYSIS_MODELS } from '@/lib/ai/models.config';
import {
  OPENROUTER_PRICING,
  OPENROUTER_PRICING_LAST_UPDATED,
} from '@/lib/ai/openrouter-pricing-data';
import { microsToUsd } from '@/lib/billing/money';

type PricingRow = {
  name: string;
  provider: string;
  license?: 'open-source' | 'proprietary';
  price: string;
  detail?: string;
};

type PricingSection = {
  id: string;
  title: string;
  description: string;
  rows: PricingRow[];
};

export type PricingCatalog = {
  sections: PricingSection[];
  lastUpdated: string;
};

/** Display label for a raw fal unit string. */
function falUnitLabel(unit: string): string {
  const u = unit.trim().toLowerCase();
  const known: Record<string, string> = {
    images: 'image',
    seconds: 'second',
    minutes: 'minute',
    megapixels: 'megapixel',
    'processed megapixels': 'megapixel',
    'compute seconds': 'compute second',
    videos: 'video',
    '1000 tokens': '1K tokens',
    units: 'generation',
  };
  return known[u] ?? (u || 'generation');
}

function formatUsd(amount: number): string {
  if (amount === 0) return 'Free';
  if (amount >= 0.01) return `$${amount.toFixed(2)}`;
  if (amount >= 0.0001) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(6)}`;
}

function formatFalPrice(
  falPricing: Record<string, EffectiveFalPricing>,
  endpointId: string
): { price: string; detail?: string } {
  const pricing = falPricing[endpointId];
  if (!pricing) {
    return { price: 'Contact support', detail: 'Pricing unavailable' };
  }

  const unitUsd = microsToUsd(pricing.unitPrice);
  const unitLabel = falUnitLabel(pricing.unit);

  // For per-call-priced models, show the typical cost the credit gate uses
  // (e.g. gpt-image-2: unit_price=$1 but ~0.22 units → ~$0.22/image).
  // Duration/megapixel models keep their per-unit rate.
  const unitsPerCall =
    estimateStrategy(endpointId, pricing.unit) === 'per_call'
      ? knownUnitsPerCall(pricing)
      : undefined;
  const typical = unitsPerCall != null ? unitUsd * unitsPerCall : null;
  if (typical != null && Math.abs(typical - unitUsd) > unitUsd * 0.05) {
    return {
      price: `~${formatUsd(typical)} / generation`,
      detail: 'Typical cost per generation (billed from provider units)',
    };
  }

  return { price: `${formatUsd(unitUsd)} / ${unitLabel}` };
}

function formatLlmPrice(modelId: string): { price: string; detail?: string } {
  const pricing = OPENROUTER_PRICING[modelId];
  if (!pricing) {
    return { price: 'Per request', detail: 'Billed at provider cost' };
  }

  const input = formatUsd(pricing.promptPerMillionTokens);
  const output = formatUsd(pricing.completionPerMillionTokens);
  const detail =
    pricing.webSearchPerQuery != null
      ? `Web search: ${formatUsd(pricing.webSearchPerQuery)} / query`
      : undefined;

  return {
    price: `${input} / M input · ${output} / M output`,
    detail,
  };
}

function visibleImageModels() {
  return Object.values(IMAGE_MODELS).filter(
    (model) => !('hidden' in model && model.hidden)
  );
}

export function buildPricingCatalog(opts: {
  falPricing: Record<string, EffectiveFalPricing>;
  /** When the fal snapshot was last refreshed (null = never). */
  falUpdatedAt: Date | null;
}): PricingCatalog {
  const { falPricing } = opts;

  const toRow = (model: {
    id: string;
    name: string;
    provider: string;
    license?: 'open-source' | 'proprietary';
  }): PricingRow => {
    const { price, detail } = formatFalPrice(falPricing, model.id);
    return {
      name: model.name,
      provider: model.provider,
      license: model.license,
      price,
      detail,
    };
  };

  const imageRows = visibleImageModels()
    .sort((a, b) => a.qualityRank - b.qualityRank)
    .map(toRow);
  const videoRows = Object.values(IMAGE_TO_VIDEO_MODELS)
    .sort((a, b) => a.qualityRank - b.qualityRank)
    .map(toRow);
  const audioRows = Object.values(AUDIO_MODELS)
    .sort((a, b) => a.qualityRank - b.qualityRank)
    .map(toRow);

  const llmRows: PricingRow[] = SCRIPT_ANALYSIS_MODELS.map((model) => {
    const { price, detail } = formatLlmPrice(model.id);
    return {
      name: model.name,
      provider: model.provider,
      license: model.license,
      price,
      detail,
    };
  });

  const dateFmt = { month: 'short', day: 'numeric', year: 'numeric' } as const;
  const falDate = opts.falUpdatedAt
    ? opts.falUpdatedAt.toLocaleDateString('en-US', dateFmt)
    : 'pending refresh';
  const orDate = new Date(OPENROUTER_PRICING_LAST_UPDATED).toLocaleDateString(
    'en-US',
    dateFmt
  );

  return {
    sections: [
      {
        id: 'llm',
        title: 'Script analysis (LLM)',
        description:
          'Script enhancement, scene splitting, character extraction, and motion prompts. Billed per request at OpenRouter provider cost — same model as openrouter.ai.',
        rows: llmRows,
      },
      {
        id: 'image',
        title: 'Image generation',
        description:
          'Shots, character sheets, location sheets, and style previews. Billed per generation at fal.ai provider cost.',
        rows: imageRows,
      },
      {
        id: 'video',
        title: 'Video / motion',
        description:
          'Image-to-video motion generation per shot. Billed per second (or flat rate where noted) at fal.ai provider cost.',
        rows: videoRows,
      },
      {
        id: 'audio',
        title: 'Music & audio',
        description:
          'Background music and soundtracks per sequence. Billed per minute or second at fal.ai provider cost.',
        rows: audioRows,
      },
    ],
    lastUpdated: `Media models: ${falDate} · LLM models: ${orDate}`,
  };
}
