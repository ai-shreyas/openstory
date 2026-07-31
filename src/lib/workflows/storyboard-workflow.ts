/**
 * Cloudflare Workflows port of `generateStoryboardWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/storyboard-workflow.ts`)
 * step for step — same step names, same control flow, same side effects.
 * Differences (all infrastructure-level, not behavioural):
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - The QStash original used `context.invoke('analyze-script', …)` to fan
 *     out to the analyze-script child and (implicitly) await its return.
 *     The CF port replaces that with `spawnAndAwaitChild` against
 *     `ANALYZE_SCRIPT_WORKFLOW` so the parent stays thin and the child gets
 *     its own retry budget (Pattern 3 — see await-child.ts).
 *   - Reads payload from `event.payload` and the workflow run id from
 *     `event.instanceId` instead of `context.requestPayload` /
 *     `context.workflowRunId`.
 *   - QStash labels are dropped — they only meant something in the QStash
 *     dashboard. CF instances surface in the Workflows dashboard via
 *     `event.instanceId`. */

import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  PREVIEW_IMAGE_MODEL,
  safeImageToVideoModel,
  safeTextToImageModel,
} from '@/lib/ai/models';
import {
  DEFAULT_ANALYSIS_MODEL,
  getAnalysisModelById,
} from '@/lib/ai/models.config';
import {
  deductWorkflowCredits,
  extractImageCost,
  recordFalUsageStep,
} from '@/lib/billing/workflow-deduction';
import { aspectRatioToImageSize } from '@/lib/constants/aspect-ratios';
import type { ScopedDb } from '@/lib/db/scoped';
import { StyleConfigSchema } from '@/lib/db/schema';
import { generateImageWithProvider } from '@/lib/image/image-generation';
import { buildPosterPrompt } from '@/lib/prompts/poster-prompt';
import { getGenerationChannel } from '@/lib/realtime';
import { validateSequenceAuth } from '@/lib/workflow/auth';
import { spawnAndAwaitChild } from '@/lib/workflow/await-child';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type {
  AnalyzeScriptWorkflowInput,
  StoryboardWorkflowInput,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'storyboard']);

export class StoryboardWorkflow extends OpenStoryWorkflowEntrypoint<StoryboardWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<StoryboardWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<void> {
    const input = event.payload;
    const { sequenceId, teamId, userId } = input;

    if (!sequenceId || !teamId || !userId) {
      throw new WorkflowValidationError(
        'Sequence ID, team ID, and user ID are required'
      );
    }
    const seq = scopedDb.sequence(sequenceId);

    const {
      title,
      script,
      aspectRatio,
      styleConfig,
      analysisModelId,
      imageModel,
      videoModel,
    } = await step.do('verify-clear-and-start-processing', async () => {
      logger.info('[StoryboardWorkflow:cf] Input received:', {
        sequenceId: input.sequenceId,
        teamId: input.teamId,
        userId: input.userId,
        autoGenerateMotion: input.autoGenerateMotion,
      });
      validateSequenceAuth(input);

      const sequence = await scopedDb.sequences.getForUser({
        sequenceId,
      });

      if (!sequence.script || sequence.script.trim().length === 0) {
        throw new NonRetryableError('Sequence has no script');
      }

      if (!sequence.styleId) {
        throw new NonRetryableError('Sequence has no style selected');
      }

      const style = await scopedDb.styles.getById(sequence.styleId);

      if (!style) {
        throw new NonRetryableError('No style found');
      }

      const existingShots = await scopedDb.shots.listBySequence(sequenceId);
      await Promise.all(
        existingShots.map((shot) => scopedDb.shots.delete(shot.id))
      );

      await seq.updateStatus('processing');

      return {
        sequenceId: sequence.id,
        title: sequence.title,
        script: sequence.script,
        aspectRatio: sequence.aspectRatio,
        styleConfig: StyleConfigSchema.parse(style.config),
        analysisModelId:
          getAnalysisModelById(sequence.analysisModel)?.id ??
          DEFAULT_ANALYSIS_MODEL,
        imageModel: safeTextToImageModel(
          sequence.imageModel,
          DEFAULT_IMAGE_MODEL
        ),
        videoModel: safeImageToVideoModel(
          sequence.videoModel,
          DEFAULT_VIDEO_MODEL
        ),
      };
    });

    // Generate a poster image from the script for the video player empty
    // state. Non-critical — failures are logged and swallowed so a poster
    // outage cannot block the storyboard. Mirrors the QStash original's
    // try/catch swallow inside the step.
    const posterResult = await step.do('generate-poster', async () => {
      try {
        const prompt = buildPosterPrompt(title, script, styleConfig);
        return await generateImageWithProvider(
          {
            model: PREVIEW_IMAGE_MODEL,
            prompt,
            imageSize: aspectRatioToImageSize(aspectRatio),
            traceName: 'poster-image',
          },
          { scopedDb }
        );
      } catch (error) {
        logger.warn('[StoryboardWorkflow:cf] Poster generation failed:', {
          err: error,
        });
        return null;
      }
    });

    if (posterResult) {
      const posterUrl = posterResult.imageUrls[0];
      if (posterUrl) {
        await step.do('save-poster', async () => {
          await scopedDb.sequences.update({ id: sequenceId, posterUrl });
          await getGenerationChannel(sequenceId).emit(
            'generation.poster:ready',
            { posterUrl }
          );
        });

        // Before the deduction guard — see recordFalUsageStep (#1069).
        const posterUsage = await recordFalUsageStep(
          step,
          scopedDb,
          posterResult.metadata,
          'record-fal-usage-poster'
        );

        await step.do('deduct-poster-credits', async () => {
          await deductWorkflowCredits({
            scopedDb,
            costMicros: extractImageCost(posterResult.metadata),
            usedOwnKey: posterResult.metadata.usedOwnKey,
            description: `Sequence poster (${PREVIEW_IMAGE_MODEL})`,
            idempotencyKey: `${event.instanceId}:poster`,
            metadata: {
              ...posterUsage,
              model: PREVIEW_IMAGE_MODEL,
              sequenceId,
            },
            workflowName: 'StoryboardWorkflow',
          });
        });
      }
    }

    // Spawn the analyze-script child and block until it returns. Pattern 3.
    await spawnAndAwaitChild<AnalyzeScriptWorkflowInput, unknown>(step, {
      binding: this.env.ANALYZE_SCRIPT_WORKFLOW,
      parentBindingName: 'STORYBOARD_WORKFLOW',
      parentInstanceId: event.instanceId,
      childId: `analyze-script:${sequenceId}`,
      childPayload: {
        userId: input.userId,
        teamId: input.teamId,
        sequenceId,
        script,
        aspectRatio,
        styleConfig,
        analysisModelId,
        imageModel,
        imageModels: input.imageModels ?? [imageModel],
        videoModel,
        videoModels: input.videoModels ?? [videoModel],
        autoGenerateMotion: input.autoGenerateMotion ?? false,
        autoGenerateMusic: input.autoGenerateMusic ?? false,
        musicModel: input.musicModel,
        audioModels: input.audioModels,
        suggestedTalentIds: input.suggestedTalentIds,
        suggestedLocationIds: input.suggestedLocationIds,
      },
      spawnStepName: 'spawn-analyze-script',
      awaitStepName: 'await-analyze-script',
      // Must exceed the child's own await budget: analyze-script's phases run
      // sequentially — scene-split (45m) + matching (45m) + bibles/visual
      // prompts (60m) + shot-images (90m) + motion-batch (90m) ≈ 5.5 hours
      // worst case — a shorter parent wait here times out first and leaves
      // the still-running child notifying a terminal parent
      // (`instance.in_finite_state`, the #801/#839 burst failures).
      // Completion notifies early, so this ceiling costs nothing in the
      // common case.
      timeout: '6 hours',
    });

    await step.do('mark-completed', async () => {
      await seq.updateStatus('completed');
    });

    await step.do('emit-complete', async () => {
      await getGenerationChannel(sequenceId).emit('generation.complete', {
        sequenceId,
      });
    });
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<StoryboardWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): Promise<void> {
    logger.error(
      `[StoryboardWorkflow:cf] Storyboard generation failed: ${error}`
    );

    // Mark the sequence failed so the user sees the failure summary + retry
    // UI instead of an eternal 'processing' spinner. The log-only QStash
    // mirror left ~20 sequences stranded when await-analyze-script timed out
    // on 2026-06-06 (issue #839).
    //
    // Skip the write when the analyze-script child already marked the
    // sequence failed — its message ("Your OpenRouter API key is invalid…")
    // is more specific than the parent's wrapper ("Child workflow
    // analyze-script… failed: …").
    const { sequenceId } = event.payload;
    if (!sequenceId) return;

    const sequence = await scopedDb.sequences.getForUser({ sequenceId });
    if (sequence.status === 'failed') return;

    await scopedDb.sequence(sequenceId).updateStatus('failed', error);
    await getGenerationChannel(sequenceId).emit('generation.failed', {
      message: error,
    });
  }
}
