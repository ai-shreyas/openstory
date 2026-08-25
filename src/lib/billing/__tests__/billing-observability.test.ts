import { describe, expect, it, vi } from 'vitest';

const loggerWarn = vi.fn();
vi.doMock('@/lib/observability/logger', () => ({
  getLogger: () => ({ warn: loggerWarn, error: vi.fn(), info: vi.fn() }),
}));

const capture = vi.fn();
vi.doMock('@/lib/posthog-server', () => ({
  getPostHogClient: () => ({ capture }),
}));

const { reportMissingBillingCost, reportSkippedDeduction } =
  await import('../billing-observability');

describe('reportMissingBillingCost', () => {
  it('logs and captures a billing_missing_cost event', () => {
    loggerWarn.mockClear();
    capture.mockClear();

    reportMissingBillingCost({
      source: 'workflow-deduction',
      workflowName: 'StoryboardWorkflow',
      modelId: 'fal/flux',
      teamId: 'team_1',
    });

    expect(loggerWarn).toHaveBeenCalledWith(
      'Completed AI generation with no billable cost reported',
      expect.objectContaining({
        source: 'workflow-deduction',
        workflowName: 'StoryboardWorkflow',
      })
    );
    expect(capture).toHaveBeenCalledWith({
      distinctId: 'team_1',
      event: 'billing_missing_cost',
      properties: expect.objectContaining({
        source: 'workflow-deduction',
        workflow_name: 'StoryboardWorkflow',
        model_id: 'fal/flux',
      }),
    });
  });
});

describe('reportSkippedDeduction', () => {
  it('logs and captures a billing_skipped_deduction event', () => {
    loggerWarn.mockClear();
    capture.mockClear();

    reportSkippedDeduction({
      teamId: 'team_1',
      workflowName: 'MotionWorkflow:cf',
      description: 'Motion generation (seedance)',
      costMicros: 1_222_200,
      idempotencyKey: 'wf-1:motion',
    });

    expect(loggerWarn).toHaveBeenCalledWith(
      'Completed AI generation skipped deduction',
      expect.objectContaining({
        workflowName: 'MotionWorkflow:cf',
        costMicros: 1_222_200,
      })
    );
    expect(capture).toHaveBeenCalledWith({
      distinctId: 'team_1',
      event: 'billing_skipped_deduction',
      properties: expect.objectContaining({
        workflow_name: 'MotionWorkflow:cf',
        cost_micros: 1_222_200,
        idempotency_key: 'wf-1:motion',
      }),
    });
  });
});
