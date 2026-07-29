/**
 * Tests for `deductWorkflowCredits` — in particular that the (now required)
 * `idempotencyKey` is forwarded to `scopedDb.billing.deductCredits`, since
 * that key is what makes a workflow-step replay charge-once (issue #846 RC1).
 */

import type { ScopedDb } from '@/lib/db/scoped';
import { describe, expect, it, vi } from 'vitest';
import { micros, ZERO_MICROS } from './money';

const reportMissingBillingCost = vi.fn();
vi.doMock('./billing-observability', () => ({
  reportMissingBillingCost,
}));

function makeScopedDb({ canAfford = true } = {}) {
  const deductCredits = vi.fn().mockResolvedValue({
    newBalance: micros(0),
    chargedAmount: micros(0),
    transactionId: 'tx1',
  });
  const hasEnoughCredits = vi.fn().mockResolvedValue(canAfford);
  const checkAutoTopUp = vi.fn().mockResolvedValue(undefined);
  const recordUsage = vi.fn().mockResolvedValue(undefined);
  const scopedDbStub = {
    billing: { deductCredits, hasEnoughCredits, checkAutoTopUp },
    modelUsage: { record: recordUsage },
  };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal ScopedDb stub exposing only the billing methods under test
  const scopedDb = scopedDbStub as unknown as ScopedDb;
  return {
    scopedDb,
    deductCredits,
    hasEnoughCredits,
    checkAutoTopUp,
    recordUsage,
  };
}

const { deductWorkflowCredits: deductWorkflowCreditsImpl } =
  await import('./workflow-deduction');

describe('deductWorkflowCredits', () => {
  it('forwards the idempotencyKey to deductCredits', async () => {
    const { scopedDb, deductCredits } = makeScopedDb();

    await deductWorkflowCreditsImpl({
      scopedDb,
      costMicros: micros(2_000_000),
      usedOwnKey: false,
      description: 'Image generation (test-model)',
      idempotencyKey: 'env_image_abc123:image',
      metadata: { shotId: 'f1' },
    });

    expect(deductCredits).toHaveBeenCalledTimes(1);
    expect(deductCredits).toHaveBeenCalledWith(micros(2_000_000), {
      description: 'Image generation (test-model)',
      metadata: { shotId: 'f1' },
      idempotencyKey: 'env_image_abc123:image',
    });
  });

  it('skips when the team used its own key', async () => {
    const { scopedDb, deductCredits } = makeScopedDb();

    await deductWorkflowCreditsImpl({
      scopedDb,
      costMicros: micros(2_000_000),
      usedOwnKey: true,
      description: 'Image generation (test-model)',
      idempotencyKey: 'env_image_abc123:image',
    });

    expect(deductCredits).not.toHaveBeenCalled();
  });

  it('reports missing cost and skips deduction for zero cost', async () => {
    reportMissingBillingCost.mockClear();
    const { scopedDb, deductCredits } = makeScopedDb();

    await deductWorkflowCreditsImpl({
      scopedDb,
      costMicros: ZERO_MICROS,
      usedOwnKey: false,
      description: 'LLM analysis (model)',
      idempotencyKey: 'env_wf_abc123:llm-step',
      workflowName: 'ImageWorkflow',
    });

    expect(deductCredits).not.toHaveBeenCalled();
    expect(reportMissingBillingCost).toHaveBeenCalledWith({
      source: 'workflow-deduction',
      workflowName: 'ImageWorkflow',
      description: 'LLM analysis (model)',
      metadata: undefined,
    });
  });

  it('skips without a scopedDb (anonymous workflow)', async () => {
    const { deductCredits } = makeScopedDb();

    await deductWorkflowCreditsImpl({
      scopedDb: undefined,
      costMicros: micros(2_000_000),
      usedOwnKey: false,
      description: 'Image generation (test-model)',
      idempotencyKey: 'env_image_abc123:image',
    });

    expect(deductCredits).not.toHaveBeenCalled();
  });

  it('warns and skips (but still kicks auto-top-up) when credits are insufficient', async () => {
    const { scopedDb, deductCredits, checkAutoTopUp } = makeScopedDb({
      canAfford: false,
    });

    await deductWorkflowCreditsImpl({
      scopedDb,
      costMicros: micros(2_000_000),
      usedOwnKey: false,
      description: 'Image generation (test-model)',
      idempotencyKey: 'env_image_abc123:image',
      workflowName: 'ImageWorkflow',
    });

    expect(deductCredits).not.toHaveBeenCalled();
    expect(checkAutoTopUp).toHaveBeenCalledTimes(1);
  });

  it('records a fal usage observation even when the team is BYOK', async () => {
    // BYOK generations are never charged, but they say just as much about a
    // model's unit count — mining only billed rows biased the median (#1069).
    const { scopedDb, deductCredits, recordUsage } = makeScopedDb({
      canAfford: true,
    });

    await deductWorkflowCreditsImpl({
      scopedDb,
      costMicros: micros(2_000_000),
      usedOwnKey: true,
      description: 'Image generation (test-model)',
      idempotencyKey: 'env_image_abc123:image',
      falUsage: { endpointId: 'fal-ai/nano-banana-2', unitsBilled: 1.5 },
    });

    expect(deductCredits).not.toHaveBeenCalled();
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage.mock.calls[0]?.[0]).toMatchObject({
      provider: 'fal',
      endpointId: 'fal-ai/nano-banana-2',
      unitsBilled: 1.5,
    });
  });
});
