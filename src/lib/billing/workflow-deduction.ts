/**
 * Workflow Credit Deduction
 * Shared utility for deducting credits after AI generation in workflows.
 * Skips deduction if team used their own API key (BYOK).
 * Warns and skips (rather than throwing) if credits are insufficient,
 * since the work has already been completed at this point.
 *
 * All monetary values are in Microdollars.
 */

import type { ScopedDb } from '@/lib/db/scoped';
import { reportMissingBillingCost } from './billing-observability';
import { type Microdollars, microsToUsd, ZERO_MICROS } from './money';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'billing', 'workflow-deduction']);

type WorkflowDeductionOpts = {
  /** Scoped DB context for the team. Skips deduction if undefined (e.g., anonymous workflows). */
  scopedDb: ScopedDb | undefined;
  costMicros: Microdollars;
  /** Set to true if the team used their own API key for this generation */
  usedOwnKey: boolean;
  description: string;
  /**
   * Stable key making this deduction idempotent across `step.do` retries.
   * Convention: `${event.instanceId}:<charge-name>` — the workflow instance
   * id is replay-stable, so a retried step recovers the original transaction
   * instead of double-charging the team.
   */
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
  /** Workflow name for the logger.warn prefix (e.g., "VariantWorkflow") */
  workflowName?: string;
};

/**
 * Deduct credits for a completed workflow generation.
 *
 * - Skips if scopedDb is undefined (no team context)
 * - Skips if costMicros <= 0
 * - Skips if the team used their own API key (usedOwnKey = true)
 * - Warns and skips if the team has insufficient credits (work already done)
 */
export async function deductWorkflowCredits(
  opts: WorkflowDeductionOpts
): Promise<void> {
  if (!opts.scopedDb || opts.usedOwnKey) return;

  if (opts.costMicros <= 0) {
    reportMissingBillingCost({
      source: 'workflow-deduction',
      workflowName: opts.workflowName,
      description: opts.description,
      metadata: opts.metadata,
    });
    return;
  }

  const { scopedDb } = opts;
  const canAfford = await scopedDb.billing.hasEnoughCredits(opts.costMicros);
  if (!canAfford) {
    const prefix = opts.workflowName ? `[${opts.workflowName}]` : '[Workflow]';
    logger.warn(
      `${prefix} Insufficient credits (cost: $${microsToUsd(opts.costMicros).toFixed(4)}), skipping deduction`
    );
    // Still attempt auto-top-up so balance can recover
    void scopedDb.billing.checkAutoTopUp().catch((err) => {
      logger.error('Failed:', { err });
    });
    return;
  }

  await scopedDb.billing.deductCredits(opts.costMicros, {
    description: opts.description,
    metadata: opts.metadata,
    idempotencyKey: opts.idempotencyKey,
  });
}

/**
 * Extract the cost from a fal.ai generation result's metadata.
 * Returns ZERO_MICROS if missing. Cost is already in Microdollars,
 * computed from fal's reported billed units (see `falCostFromUnits`).
 */
export function extractImageCost(metadata: {
  cost?: Microdollars;
}): Microdollars {
  return metadata.cost ?? ZERO_MICROS;
}

/**
 * Transaction-metadata fields the daily pricing cron mines to derive observed
 * median units per fal endpoint (#1069). Spread into the `metadata` of every
 * fal-backed deduction so estimates self-correct from real usage.
 */
export function falUsageMetadata(metadata: {
  endpointId: string;
  unitsBilled?: number;
}): { endpointId: string; unitsBilled?: number } {
  return {
    endpointId: metadata.endpointId,
    unitsBilled: metadata.unitsBilled,
  };
}
