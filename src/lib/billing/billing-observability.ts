/**
 * Observability for billing gaps — when a completed AI call reports no cost.
 */

import { getPostHogClient } from '@/lib/posthog-server';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'billing', 'missing-cost']);

export type MissingBillingCostContext = {
  source: string;
  modelId?: string;
  workflowName?: string;
  description?: string;
  teamId?: string;
  metadata?: Record<string, unknown>;
};

export type FlooredEstimateContext = {
  model: string;
  operation: string;
  numCalls: number;
  floorMicros: number;
};

/**
 * Emit analytics when the credit gate substitutes the unknown-estimate floor
 * for a model it cannot price.
 *
 * Fires on **every** substitution, unlike `gateEstimate`'s log, which dedupes
 * per isolate to survive per-shot loops. The rate is the whole point: #1069
 * went unnoticed for months because a fabricated estimate produced no signal
 * anyone could count, and a floored gate is the same shape of unknown.
 */
export function reportFlooredEstimate(ctx: FlooredEstimateContext): void {
  const posthog = getPostHogClient();
  posthog?.capture({
    distinctId: 'system',
    event: 'billing_estimate_floored',
    properties: {
      model: ctx.model,
      operation: ctx.operation,
      num_calls: ctx.numCalls,
      floor_micros: ctx.floorMicros,
    },
  });
}

/** Log and emit analytics when a completed generation has nothing to bill. */
export function reportMissingBillingCost(ctx: MissingBillingCostContext): void {
  logger.warn('Completed AI generation with no billable cost reported', ctx);

  const posthog = getPostHogClient();
  posthog?.capture({
    distinctId: ctx.teamId ?? 'system',
    event: 'billing_missing_cost',
    properties: {
      source: ctx.source,
      model_id: ctx.modelId,
      workflow_name: ctx.workflowName,
      description: ctx.description,
      ...ctx.metadata,
    },
  });
}
