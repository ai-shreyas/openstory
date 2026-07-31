import {
  getEffectiveFalPricing,
  getFalPricingUpdatedAt,
} from '@/lib/ai/fal-pricing-live';
import {
  buildPricingCatalog,
  type PricingCatalog,
} from '@/lib/billing/pricing-catalog';
import { createServerFn } from '@tanstack/react-start';

/** Public pricing catalog for the /pricing page, from live `model_pricing`. */
export const getPricingCatalogFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<PricingCatalog> => {
    const [falPricing, falUpdatedAt] = await Promise.all([
      getEffectiveFalPricing(),
      getFalPricingUpdatedAt(),
    ]);
    return buildPricingCatalog({ falPricing, falUpdatedAt });
  }
);
