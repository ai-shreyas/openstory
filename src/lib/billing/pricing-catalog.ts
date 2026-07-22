/**
 * Public model pricing catalog — single source for the /pricing page.
 * Combines fal media pricing with OpenRouter LLM token rates.
 */

import {
  FAL_PRICING,
  PRICING_LAST_UPDATED as FAL_PRICING_LAST_UPDATED,
  type FalUnit,
} from '@/lib/ai/fal-pricing-data';
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

export type PricingSection = {
  id: string;
  title: string;
  description: string;
  rows: PricingRow[];
};

const FAL_UNIT_LABELS: Record<FalUnit, string> = {
  images: 'image',
  seconds: 'second',
  minutes: 'minute',
  megapixels: 'megapixel',
  compute_seconds: 'compute second',
  flat: 'generation',
  tokens: '1K tokens',
};

function formatUsd(amount: number): string {
  if (amount === 0) return 'Free';
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  if (amount >= 0.01) return `$${amount.toFixed(2)}`;
  if (amount >= 0.0001) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(6)}`;
}

function formatFalPrice(endpointId: string): {
  price: string;
  detail?: string;
} {
  const pricing = FAL_PRICING[endpointId];
  if (!pricing) {
    return { price: 'Contact support', detail: 'Pricing unavailable' };
  }

  const unitUsd = microsToUsd(pricing.unitPrice);
  const unitLabel = FAL_UNIT_LABELS[pricing.unit];

  // Prefer typical per-call cost when fal historical units differ from 1
  // (e.g. gpt-image-2: unit_price=$1 but ~0.22 units → ~$0.22/image).
  const typical =
    pricing.typicalUnitsPerCall != null &&
    pricing.typicalUnitsPerCall > 0 &&
    (pricing.unit === 'images' || pricing.unit === 'flat')
      ? unitUsd * pricing.typicalUnitsPerCall
      : null;

  if (typical != null && Math.abs(typical - unitUsd) > unitUsd * 0.05) {
    return {
      price: `~${formatUsd(typical)} / ${unitLabel}`,
      detail:
        pricing.unit === 'flat'
          ? 'Typical cost per generation (billed from provider units)'
          : 'Typical cost per image (billed from provider units)',
    };
  }

  return {
    price: `${formatUsd(unitUsd)} / ${unitLabel}`,
    detail:
      pricing.unit === 'flat'
        ? 'Flat rate per video'
        : pricing.unit === 'tokens'
          ? 'Billed per 1,000 video tokens'
          : undefined,
  };
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

export function buildPricingCatalog(): {
  sections: PricingSection[];
  lastUpdated: string;
} {
  const imageRows: PricingRow[] = visibleImageModels()
    .sort((a, b) => a.qualityRank - b.qualityRank)
    .map((model) => {
      const { price, detail } = formatFalPrice(model.id);
      return {
        name: model.name,
        provider: model.provider,
        license: model.license,
        price,
        detail,
      };
    });

  const videoRows: PricingRow[] = Object.values(IMAGE_TO_VIDEO_MODELS)
    .sort((a, b) => a.qualityRank - b.qualityRank)
    .map((model) => {
      const { price, detail } = formatFalPrice(model.id);
      return {
        name: model.name,
        provider: model.provider,
        license: model.license,
        price,
        detail,
      };
    });

  const audioRows: PricingRow[] = Object.values(AUDIO_MODELS)
    .sort((a, b) => a.qualityRank - b.qualityRank)
    .map((model) => {
      const { price, detail } = formatFalPrice(model.id);
      return {
        name: model.name,
        provider: model.provider,
        license: model.license,
        price,
        detail,
      };
    });

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

  const falDate = new Date(FAL_PRICING_LAST_UPDATED).toLocaleDateString(
    'en-US',
    { month: 'short', day: 'numeric', year: 'numeric' }
  );
  const orDate = new Date(OPENROUTER_PRICING_LAST_UPDATED).toLocaleDateString(
    'en-US',
    { month: 'short', day: 'numeric', year: 'numeric' }
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
