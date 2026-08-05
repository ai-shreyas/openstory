/**
 * Cloudflare Workflows port of `elementVisionWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/element-vision-workflow.ts`)
 * step for step — same step names, same control flow, same side effects.
 * The only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads the workflow run id from `event.instanceId` instead of
 *     `context.workflowRunId` (not needed for this workflow, but listed
 *     here for parity with the other CF ports). */

import {
  describeElementImage,
  ELEMENT_VISION_MODEL,
} from '@/lib/ai/element-vision';
import { deductWorkflowCredits } from '@/lib/billing/workflow-deduction';
import type { ScopedDb } from '@/lib/db/scoped';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import type {
  ElementVisionWorkflowInput,
  ElementVisionWorkflowResult,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'element-vision']);

export class ElementVisionWorkflow extends OpenStoryWorkflowEntrypoint<ElementVisionWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<ElementVisionWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<ElementVisionWorkflowResult> {
    const input = event.payload;
    const { elementId, imageUrl, filename } = input;

    // Step 1: mark analyzing
    await step.do('mark-analyzing', async () => {
      await scopedDb.sequenceElements.updateVisionStatus(
        elementId,
        'analyzing'
      );
    });

    // Step 2: load element so we know the current token (for auto-rename).
    const element = await step.do('load-element', async () => {
      const el = await scopedDb.sequenceElements.getById(elementId);
      if (!el) throw new Error(`Element ${elementId} not found`);
      return el;
    });

    // Step 3: vision call (also returns a vision-suggested token).
    const vision = await step.do('describe-element', async () => {
      const llmKeyInfo = await scopedDb.apiKeys.resolveLlmKey();
      return await describeElementImage({
        imageUrl,
        filename,
        llmKey: llmKeyInfo,
      });
    });

    await step.do('deduct-vision-credits', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: vision.costMicros,
        usedOwnKey: vision.usedOwnKey,
        description: `Element vision (${ELEMENT_VISION_MODEL})`,
        idempotencyKey: `${event.instanceId}:vision`,
        metadata: {
          model: ELEMENT_VISION_MODEL,
          elementId,
        },
        workflowName: 'ElementVisionWorkflow',
      });
    });

    const { description, consistencyTag, suggestedToken } = vision;

    // Step 4: persist description + consistencyTag.
    await step.do('persist-vision', async () => {
      await scopedDb.sequenceElements.updateVisionResult(
        elementId,
        description,
        consistencyTag
      );
    });

    // Step 5: auto-rename to vision-suggested token if different. Uses
    // ensureUniqueToken (suffixes `_2` on collision) because the system is
    // choosing the name — failing the workflow on collision would strand the
    // element with no usable name. Excluding the element's own row keeps a
    // step retry idempotent: after a successful rename the replay gets the
    // suggested token back un-suffixed, and — since the in-memory
    // `element.token` still holds the pre-rename name, so neither early
    // return fires — the cascade re-runs, atomically yielding zero deltas.
    const finalToken = await step.do('auto-rename', async () => {
      if (suggestedToken === element.token) return element.token;
      const unique = await scopedDb.sequenceElements.ensureUniqueToken(
        element.sequenceId,
        suggestedToken,
        elementId
      );
      if (unique === element.token) return element.token;
      const result = await scopedDb.sequenceElements.cascadeRename({
        sequenceId: element.sequenceId,
        elementId,
        oldToken: element.token,
        newToken: unique,
      });
      return result.element.token;
    });

    return {
      elementId,
      description,
      consistencyTag,
      token: finalToken,
    };
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<ElementVisionWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): Promise<void> {
    const { elementId } = event.payload;
    logger.error('[ElementVisionWorkflow:cf] Failed:', {
      err: error,
    });
    try {
      await scopedDb.sequenceElements.updateVisionStatus(
        elementId,
        'failed',
        error
      );
    } catch (e) {
      logger.error('[ElementVisionWorkflow:cf] Failed to persist error:', {
        e,
      });
    }
  }
}
