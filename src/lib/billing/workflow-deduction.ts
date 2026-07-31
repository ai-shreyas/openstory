/**
 * Workflow Credit Deduction
 * Shared utility for deducting credits after AI generation in workflows.
 * Skips deduction if team used their own API key (BYOK).
 * Warns and skips (rather than throwing) if credits are insufficient,
 * since the work has already been completed at this point.
 *
 * Pricing observations are deliberately NOT recorded here. Charging a team and
 * learning what a model bills are independent concerns, and coupling them is
 * what made #1069 self-sealing: every call site guards deduction behind
 * `cost > 0 && !usedOwnKey`, so a recorder living inside this function would
 * never see the BYOK and unpriced generations whose units we most need. Use
 * `recordFalUsage` in its own workflow step instead.
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
  if (!opts.scopedDb) return;
  const { scopedDb } = opts;

  if (opts.usedOwnKey) return;

  if (opts.costMicros <= 0) {
    reportMissingBillingCost({
      source: 'workflow-deduction',
      workflowName: opts.workflowName,
      description: opts.description,
      metadata: opts.metadata,
    });
    return;
  }

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
 * What one fal call billed. `numImages` matters because `unitsBilled` is per
 * *call* while estimation works per image — the median divides by it.
 */
export type FalUsage = {
  endpointId: string;
  unitsBilled?: number;
  numImages?: number;
};

/**
 * Narrow a generation result's metadata to the usage fields, for spreading into
 * a credit transaction's metadata so a charge can be traced back to its units.
 * Recording an observation takes the result metadata directly — this is only
 * for the billing trail.
 */
export function falUsageMetadata(metadata: FalUsage): FalUsage {
  return {
    endpointId: metadata.endpointId,
    unitsBilled: metadata.unitsBilled,
    numImages: metadata.numImages,
  };
}

/**
 * Persist one usage sample for the pricing cron's observed median (#1069).
 *
 * Call this for **every** fal generation, in its own `step.do`, before any
 * `cost > 0 && !usedOwnKey` branching — BYOK and unpriced generations tell us
 * just as much about a model's unit count as billed ones, and an unpriced
 * model has no other route off the `UNKNOWN_ESTIMATE_FLOOR`. Its own step also
 * makes the insert replay-safe: outside one, a workflow replay re-records.
 *
 * Best-effort: a failure here must never fail a generation that already
 * succeeded and was already paid for, so it logs rather than throws. Samples
 * with no `unitsBilled` carry no signal and are skipped.
 */
export async function recordFalUsage(
  scopedDb: ScopedDb | undefined,
  usage: FalUsage
): Promise<void> {
  // Observations are platform-global telemetry with no teamId (see
  // model_usage_observations), but the write still needs a db handle.
  if (!scopedDb) return;
  const { unitsBilled } = usage;
  if (
    unitsBilled == null ||
    !Number.isFinite(unitsBilled) ||
    unitsBilled <= 0
  ) {
    return;
  }
  try {
    await scopedDb.modelUsage.record({
      provider: 'fal',
      endpointId: usage.endpointId,
      unitsBilled,
      numImages: usage.numImages,
    });
  } catch (err) {
    logger.error('Failed to record fal usage observation', {
      err,
      endpointId: usage.endpointId,
    });
  }
}
