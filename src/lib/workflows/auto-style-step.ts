/**
 * Automatic style derivation (#1213), run by analyze-script in parallel with
 * scene-split. Runs one billed LLM call over the snapshotted script, writes the
 * recipe onto the sequence-bound style row and the sequence's own snapshot,
 * and hands the resolved `StyleConfig` back for every child payload.
 */
import type { AnalysisModelId } from '@/lib/ai/models.config';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import { getLogger } from '@/lib/observability/logger';
import { getGenerationChannel } from '@/lib/realtime';
import {
  autoStyleDraftFromResponse,
  autoStyleResponseSchema,
} from '@/lib/style/auto-style';
import type { StyleConfig } from '@/lib/style/style-config';
import { durableLLMCallCf } from '@/lib/workflows/llm-call-helper';
import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

const logger = getLogger(['openstory', 'workflow', 'auto-style']);

export async function deriveAutoStyle(
  step: WorkflowStep,
  params: {
    scopedDb: WorkflowScopedDb;
    workflowRunId: string;
    sequenceId: string;
    styleId: string;
    script: string;
    aspectRatio: AspectRatio;
    analysisModelId: AnalysisModelId;
  }
): Promise<StyleConfig> {
  const { scopedDb, sequenceId, styleId } = params;

  const response = await durableLLMCallCf(
    step,
    {
      name: 'automatic-style',
      phase: { number: 1, name: 'Analyzing script & deriving a style…' },
      promptName: 'phase/automatic-style-chat',
      promptVariables: {
        script: params.script,
        aspectRatio: params.aspectRatio,
      },
      modelId: params.analysisModelId,
      responseSchema: autoStyleResponseSchema,
      additionalMetadata: { styleId },
      reasoning: true,
    },
    { sequenceId, workflowRunId: params.workflowRunId, scopedDb }
  );

  const draft = autoStyleDraftFromResponse(response);

  await step.do('save-automatic-style', async () => {
    const bound = await scopedDb.styles.setGeneratedForSequence({
      styleId,
      sequenceId,
      draft,
    });
    if (!bound) {
      // The row was promoted (or the sequence re-styled) between the trigger
      // and this step — a library row must never be rewritten by a run.
      throw new NonRetryableError(
        `Automatic style ${styleId} is no longer bound to sequence ${sequenceId}`
      );
    }
    // Re-snapshots from the row just written, so the sequence carries the
    // derived recipe like any library pick would.
    await scopedDb.sequences.update({ id: sequenceId, styleId });
    await getGenerationChannel(sequenceId).emit('generation.style:ready', {
      styleId,
      name: draft.name,
    });
    logger.info('[AutoStyle:cf] derived style saved', {
      sequenceId,
      styleId,
      name: draft.name,
    });
  });

  return draft.config;
}
