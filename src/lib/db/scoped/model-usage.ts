/**
 * Model usage observations (#1069).
 *
 * Raw per-generation samples of what a provider actually billed, and the input
 * to the observed median that pre-flight estimation prefers. Written for every
 * fal generation that reports `unitsBilled` — billed, BYOK, unpriced, or
 * over-drawn — so the median reflects how models behave rather than which
 * teams happen to be billable. See `recordFalUsage` for the write path.
 *
 * Platform-global telemetry, not team data: no `teamId`, no scoping.
 */

import type { Database } from '@/lib/db/client';
import { modelUsageObservations } from '@/lib/db/schema';
import type { ModelPricingProvider } from '@/lib/db/schema/model-pricing';

export function createModelUsageMethods(db: Database) {
  return {
    /** Record one call's billed units. */
    async record(sample: {
      provider: ModelPricingProvider;
      endpointId: string;
      unitsBilled: number;
      numImages?: number;
    }): Promise<void> {
      await db.insert(modelUsageObservations).values({
        provider: sample.provider,
        endpointId: sample.endpointId,
        unitsBilled: sample.unitsBilled,
        numImages: sample.numImages ?? 1,
      });
    },
  };
}
