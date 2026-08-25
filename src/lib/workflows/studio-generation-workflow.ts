/**
 * Prompt-only Images and Videos (#1274).
 *
 * Sequence models only — `generateImageWithProvider` and `submitMotionJob`,
 * the same paths as storyboard stills and clips, so native Grok and billed
 * fal units work. Video is still-then-motion: the prompt renders a start
 * frame, then the chosen image-to-video model animates it.
 *
 *   1. set-running
 *   2. generate-image (and, for video, generate-still + submit/poll motion)
 *   3. deduct-credits from reported units
 *   4. upload outputs to R2
 *   5. persist-result on the reserved `generated_assets` row
 */

import {
  CONTENT_REJECTION_EVENT,
  isContentRejectionError,
} from '@/lib/ai/content-rejection';
import { extractFalErrorMessage } from '@/lib/ai/fal-error';
import { ZERO_MICROS, addMicros, type Microdollars } from '@/lib/billing/money';
import {
  deductWorkflowCredits,
  recordFalUsageStep,
} from '@/lib/billing/workflow-deduction';
import { recordProvenance } from '@/lib/compliance/provenance';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import type { GeneratedAssetOutput } from '@/lib/db/schema';
import { generateImageWithProvider } from '@/lib/image/image-generation';
import {
  motionCostFromUsage,
  pollMotionJob,
  submitMotionJob,
} from '@/lib/motion/motion-generation';
import { getLogger } from '@/lib/observability/logger';
import { uploadStudioImage, uploadStudioVideo } from '@/lib/studio/upload';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import type { StudioGenerationWorkflowInput } from '@/lib/workflow/types';
import type { TokenUsage } from '@tanstack/ai';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

const logger = getLogger(['openstory', 'workflow', 'studio']);

const POLL_BATCH_DURATION_MS = 30_000;
const MAX_BATCHES = 60;
const MAX_MOTION_ATTEMPTS = 3;

type StudioPollOutcome =
  | { kind: 'pending' }
  | { kind: 'completed'; url: string; usage?: TokenUsage }
  | { kind: 'rejected'; rejection: string }
  | { kind: 'failed'; error: string };

function classifyMotionFailure(message: string): StudioPollOutcome {
  return isContentRejectionError(message)
    ? { kind: 'rejected', rejection: message }
    : { kind: 'failed', error: `Motion generation failed: ${message}` };
}

export type StudioPersistScopedDb = {
  generatedAssets: {
    markRunning: (id: string) => Promise<void>;
    markCompleted: (
      id: string,
      fields: { outputs: GeneratedAssetOutput[]; costMicros?: number | null }
    ) => Promise<void>;
    markFailed: (id: string, error: string) => Promise<void>;
  };
};

export async function persistStudioCompletion(params: {
  scopedDb: StudioPersistScopedDb;
  assetId: string;
  outputs: GeneratedAssetOutput[];
  costMicros: Microdollars | null;
}): Promise<void> {
  await params.scopedDb.generatedAssets.markCompleted(params.assetId, {
    outputs: params.outputs,
    costMicros: params.costMicros,
  });
}

export async function persistStudioFailure(params: {
  scopedDb: StudioPersistScopedDb;
  assetId: string;
  error: string;
}): Promise<void> {
  await params.scopedDb.generatedAssets.markFailed(
    params.assetId,
    params.error
  );
}

export class StudioGenerationWorkflow extends OpenStoryWorkflowEntrypoint<StudioGenerationWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<StudioGenerationWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<{ assetId: string; outputs: GeneratedAssetOutput[] }> {
    const input = event.payload;
    const { activity, assetId } = input;

    await step.do('set-running', async () => {
      await scopedDb.generatedAssets.markRunning(assetId);
    });

    if (activity === 'image') {
      return this.runImage(event, step, scopedDb);
    }
    return this.runVideo(event, step, scopedDb);
  }

  private async runImage(
    event: Readonly<WorkflowEvent<StudioGenerationWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<{ assetId: string; outputs: GeneratedAssetOutput[] }> {
    const input = event.payload;
    const { assetId, teamId } = input;

    const imageResult = await step.do('generate-image', async () => {
      logger.info(
        `[StudioGenerationWorkflow] Generating image ${assetId} with ${input.imageModel}`
      );
      return generateImageWithProvider(
        {
          model: input.imageModel,
          prompt: input.prompt,
          imageSize: input.imageSize,
          numImages: 1,
        },
        {
          scopedDb: scopedDb.credentials,
          observability: {
            observationName: 'studio-image',
            tags: ['studio', 'image'],
            userId: input.userId,
            metadata: { assetId, model: input.imageModel },
          },
        }
      );
    });

    const generatedImageUrl = imageResult.imageUrls[0];
    if (!generatedImageUrl) {
      throw new Error('Image generation did not return any image URLs');
    }

    const imageCost = imageResult.metadata.cost ?? ZERO_MICROS;
    const falUsage =
      imageResult.via === 'fal'
        ? await recordFalUsageStep(step, scopedDb, imageResult.metadata)
        : {};

    if (imageCost > 0 && !imageResult.metadata.usedOwnKey) {
      await step.do('deduct-credits', async () => {
        await deductWorkflowCredits({
          scopedDb,
          costMicros: imageCost,
          usedOwnKey: imageResult.metadata.usedOwnKey,
          description: `Studio image (${input.imageModel})`,
          idempotencyKey: `${event.instanceId}:studio-image`,
          metadata: {
            ...falUsage,
            model: input.imageModel,
            assetId,
          },
          workflowName: 'StudioGenerationWorkflow',
        });
      });
    }

    const upload = await step.do('upload-image', async () => {
      return uploadStudioImage({
        imageUrl: generatedImageUrl,
        teamId,
        assetId,
      });
    });

    const outputs: GeneratedAssetOutput[] = [
      { url: upload.url, contentType: upload.contentType },
    ];

    await step.do('persist-result', async () => {
      await persistStudioCompletion({
        scopedDb,
        assetId,
        outputs,
        costMicros: imageCost,
      });
    });

    await step.do('record-provenance', async () => {
      await recordProvenance(scopedDb.provenance, {
        teamId,
        userId: input.userId,
        assetKind: 'generated_asset',
        assetId,
        storageKey: upload.path,
        provider: imageResult.via,
        model: imageResult.metadata.endpointId,
        providerRequestId: imageResult.metadata.requestId,
        workflowRunId: event.instanceId,
        prompt: input.prompt,
      });
    });

    return { assetId, outputs };
  }

  private async runVideo(
    event: Readonly<WorkflowEvent<StudioGenerationWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<{ assetId: string; outputs: GeneratedAssetOutput[] }> {
    const input = event.payload;
    const { assetId, teamId } = input;
    const videoModel = input.videoModel;
    if (!videoModel) {
      throw new Error('Studio video generation requires a video model');
    }

    const stillResult = await step.do('generate-still', async () => {
      logger.info(
        `[StudioGenerationWorkflow] Generating start frame ${assetId} with ${input.imageModel}`
      );
      return generateImageWithProvider(
        {
          model: input.imageModel,
          prompt: input.prompt,
          imageSize: input.imageSize,
          numImages: 1,
        },
        {
          scopedDb: scopedDb.credentials,
          observability: {
            observationName: 'studio-still',
            tags: ['studio', 'image'],
            userId: input.userId,
            metadata: { assetId, model: input.imageModel },
          },
        }
      );
    });

    const stillUrl = stillResult.imageUrls[0];
    if (!stillUrl) {
      throw new Error('Still generation did not return any image URLs');
    }

    const stillCost = stillResult.metadata.cost ?? ZERO_MICROS;
    const stillUsage =
      stillResult.via === 'fal'
        ? await recordFalUsageStep(
            step,
            scopedDb,
            stillResult.metadata,
            'record-still-fal-usage'
          )
        : {};

    if (stillCost > 0 && !stillResult.metadata.usedOwnKey) {
      await step.do('deduct-still-credits', async () => {
        await deductWorkflowCredits({
          scopedDb,
          costMicros: stillCost,
          usedOwnKey: stillResult.metadata.usedOwnKey,
          description: `Studio still (${input.imageModel})`,
          idempotencyKey: `${event.instanceId}:studio-still`,
          metadata: {
            ...stillUsage,
            model: input.imageModel,
            assetId,
          },
          workflowName: 'StudioGenerationWorkflow',
        });
      });
    }

    const stillUpload = await step.do('upload-still', async () => {
      return uploadStudioImage({
        imageUrl: stillUrl,
        teamId,
        assetId,
      });
    });

    let videoUrl = '';
    let billedUsage: TokenUsage | undefined;
    let lastRejection: string | null = null;
    let succeededJob: Awaited<ReturnType<typeof submitMotionJob>> | null = null;

    for (let attempt = 0; attempt < MAX_MOTION_ATTEMPTS; attempt++) {
      const tag = attempt === 0 ? '' : `-retry-${attempt}`;
      const submitOutcome = await step.do(`submit-motion${tag}`, async () => {
        try {
          const job = await submitMotionJob({
            imageUrl: stillUpload.url,
            prompt: input.prompt,
            model: videoModel,
            duration: input.duration,
            aspectRatio: input.aspectRatio,
            generateAudio: input.generateAudio,
            scopedDb: scopedDb.credentials,
          });
          return { ok: true as const, job };
        } catch (error) {
          if (isContentRejectionError(error)) {
            return {
              ok: false as const,
              rejection: extractFalErrorMessage(error),
            };
          }
          if (
            error instanceof Error &&
            'status' in error &&
            error.status === 422
          ) {
            throw new NonRetryableError(
              `Motion job submission rejected (422): ${extractFalErrorMessage(error)}`
            );
          }
          throw error;
        }
      });

      if (!submitOutcome.ok) {
        lastRejection = submitOutcome.rejection;
        logger.warn(
          `[StudioGenerationWorkflow] content-flag rejection on submit attempt ${attempt + 1}/${MAX_MOTION_ATTEMPTS} for ${assetId}: ${submitOutcome.rejection}`,
          { event: CONTENT_REJECTION_EVENT }
        );
        continue;
      }
      const { job } = submitOutcome;

      let rejected: string | null = null;
      for (let batch = 0; batch < MAX_BATCHES; batch++) {
        if (batch > 0) {
          await step.sleep(`motion-batch-wait-${attempt}-${batch}`, 1);
        }

        const poll = await step.do(
          `motion-poll-batch-${attempt}-${batch}`,
          async (): Promise<StudioPollOutcome> => {
            const deadline = Date.now() + POLL_BATCH_DURATION_MS;
            while (Date.now() < deadline) {
              let pollResult: Awaited<ReturnType<typeof pollMotionJob>>;
              try {
                pollResult = await pollMotionJob(
                  job.jobId,
                  job.modelKey,
                  scopedDb.credentials,
                  job.via
                );
              } catch (error) {
                if (isContentRejectionError(error)) {
                  return {
                    kind: 'rejected',
                    rejection: extractFalErrorMessage(error),
                  };
                }
                if (
                  error instanceof Error &&
                  'status' in error &&
                  error.status === 422
                ) {
                  return {
                    kind: 'failed',
                    error: `Motion job polling failed (422): ${extractFalErrorMessage(error)}`,
                  };
                }
                throw error;
              }

              if (pollResult.status === 'completed') {
                if (pollResult.url) {
                  return {
                    kind: 'completed',
                    url: pollResult.url,
                    usage: pollResult.usage,
                  };
                }
                return classifyMotionFailure(
                  pollResult.error || 'No URL returned'
                );
              }
              if (pollResult.status === 'failed') {
                return classifyMotionFailure(
                  pollResult.error || 'Unknown error'
                );
              }
            }
            return { kind: 'pending' };
          }
        );

        if (poll.kind === 'completed') {
          videoUrl = poll.url;
          billedUsage = poll.usage;
          break;
        }
        if (poll.kind === 'rejected') {
          rejected = poll.rejection;
          break;
        }
        if (poll.kind === 'failed') {
          throw new NonRetryableError(poll.error);
        }
      }

      if (videoUrl) {
        succeededJob = job;
        break;
      }
      if (rejected) {
        lastRejection = rejected;
        continue;
      }
      throw new Error(
        `Motion generation timed out after ${(MAX_BATCHES * POLL_BATCH_DURATION_MS) / 60_000} minutes`
      );
    }

    if (!videoUrl || !succeededJob) {
      throw new NonRetryableError(
        `Motion generation rejected by content filter after ${MAX_MOTION_ATTEMPTS} attempts: ${lastRejection ?? 'unknown rejection'}`,
        'ContentRejectionExhausted'
      );
    }
    const job = succeededJob;

    const billing = await step.do('price-motion-generation', async () =>
      motionCostFromUsage(job.via, billedUsage, {
        modelKey: job.modelKey,
        hasReferenceImages: false,
      })
    );
    const motionCost = billing.cost;

    if (billing.recordFalUsage) {
      await recordFalUsageStep(
        step,
        scopedDb,
        {
          endpointId: billing.endpointId,
          unitsBilled: billing.unitsBilled,
          numImages: 1,
        },
        'record-motion-fal-usage'
      );
    }

    if (motionCost > 0 && !job.usedOwnKey) {
      await step.do('deduct-motion-credits', async () => {
        await deductWorkflowCredits({
          scopedDb,
          costMicros: motionCost,
          usedOwnKey: job.usedOwnKey,
          description: `Studio video (${videoModel})`,
          idempotencyKey: `${event.instanceId}:studio-video`,
          metadata: {
            model: videoModel,
            assetId,
            requestId: job.jobId,
          },
          workflowName: 'StudioGenerationWorkflow',
        });
      });
    }

    const videoUpload = await step.do('upload-video', async () => {
      return uploadStudioVideo({
        videoUrl,
        teamId,
        assetId,
      });
    });

    const outputs: GeneratedAssetOutput[] = [
      { url: stillUpload.url, contentType: stillUpload.contentType },
      { url: videoUpload.url, contentType: videoUpload.contentType },
    ];
    const totalCost: Microdollars = addMicros(stillCost, motionCost);

    await step.do('persist-result', async () => {
      await persistStudioCompletion({
        scopedDb,
        assetId,
        outputs,
        costMicros: totalCost,
      });
    });

    await step.do('record-provenance', async () => {
      await recordProvenance(scopedDb.provenance, {
        teamId,
        userId: input.userId,
        assetKind: 'generated_asset',
        assetId: `${assetId}#still`,
        storageKey: stillUpload.path,
        provider: stillResult.via,
        model: stillResult.metadata.endpointId,
        providerRequestId: stillResult.metadata.requestId,
        workflowRunId: event.instanceId,
        prompt: input.prompt,
      });
      await recordProvenance(scopedDb.provenance, {
        teamId,
        userId: input.userId,
        assetKind: 'generated_asset',
        assetId,
        storageKey: videoUpload.path,
        provider: job.via,
        model: billing.endpointId,
        providerRequestId: job.jobId,
        workflowRunId: event.instanceId,
        prompt: input.prompt,
      });
    });

    return { assetId, outputs };
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<StudioGenerationWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): Promise<void> {
    await persistStudioFailure({
      scopedDb,
      assetId: event.payload.assetId,
      error,
    });
    logger.error(
      `[StudioGenerationWorkflow] Asset ${event.payload.assetId} failed: ${error}`
    );
  }
}
