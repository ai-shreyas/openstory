/**
 * Load the fal pricing map from the local D1 `model_pricing` table — the same
 * data the app reads at runtime. Run `bun scripts/refresh-fal-pricing.ts`
 * first to fill it.
 */
import {
  buildFalPricingMap,
  type EffectiveFalPricing,
} from '@/lib/ai/fal-pricing-live';
import { modelPricing } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { getLocalPlatformProxy } from './local-platform-proxy';

export async function loadLocalFalPricing(): Promise<
  Record<string, EffectiveFalPricing>
> {
  const platformProxy = await getLocalPlatformProxy<{ DB?: D1Database }>({});
  try {
    const binding = platformProxy.env.DB;
    if (!binding) {
      throw new Error("D1 binding 'DB' missing from wrangler.jsonc");
    }
    const rows = await drizzle(binding)
      .select()
      .from(modelPricing)
      .where(eq(modelPricing.provider, 'fal'));
    if (rows.length === 0) {
      throw new Error(
        'local model_pricing is empty — run `bun scripts/refresh-fal-pricing.ts` first'
      );
    }
    return buildFalPricingMap(rows);
  } finally {
    await platformProxy.dispose();
  }
}
