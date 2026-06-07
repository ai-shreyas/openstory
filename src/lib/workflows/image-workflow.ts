/**
 * Cloudflare Workflows port of `generateImageWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/image-workflow.ts`) step
 * for step — same step names, same control flow, same side effects. The
 * only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads the workflow run id from `event.instanceId` instead of
 *     `context.workflowRunId`.
 *   - Calls the snapshot DTO computers directly instead of going through
 *     the `context.snapshot.*` extension. */

import { computeVisualPromptInputHash } from '@/lib/ai/input-hash';
import { DEFAULT_IMAGE_MODEL, IMAGE_MODELS } from '@/lib/ai/models';
import { loadNarrowShotPromptContext } from '@/lib/ai/prompt-context';
import { ZERO_MICROS } from '@/lib/billing/money';
import { deductWorkflowCredits } from '@/lib/billing/workflow-deduction';
import { DEFAULT_IMAGE_SIZE } from '@/lib/constants/aspect-ratios';
import type { ScopedDb } from '@/lib/db/scoped';
import {
  CONTENT_REJECTION_EVENT,
  isContentRejectionError,
} from '@/lib/ai/content-rejection';
import {
  generateImageWithProvider,
  type ImageGenerationParams,
} from '@/lib/image/image-generation';
import { uploadImageToStorage } from '@/lib/image/image-storage';
import { buildReferenceImagePrompt } from '@/lib/prompts/reference-image-prompt';
import { getGenerationChannel } from '@/lib/realtime';
import { simpleHash } from '@/lib/utils/hash';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type { ImageWorkflowInput } from '@/lib/workflow/types';
import type { ReferenceImageDescription } from '@/lib/prompts/reference-image-prompt';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import {
  computeImageWorkflowHashCurrent,
  computeImageWorkflowHashFromDto,
  persistImageResult,
} from '@/lib/workflows/image-workflow-snapshot';
import { shouldRecordUserEdit } from '@/lib/workflows/user-edit-predicate';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'image']);

type ImageWorkflowResult = {
  imageUrl: string;
  shotId?: string;
  sequenceId?: string;
};

export class ImageWorkflow extends OpenStoryWorkflowEntrypoint<ImageWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<ImageWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<ImageWorkflowResult> {
    const rawInput = event.payload;
    // Back-compat: accept shotId or shotId from in-flight instances serialized before #906
    // TODO(#906): remove shotId shim one release after deploy
    const input = {
      ...rawInput,
      shotId:
        rawInput.shotId ??
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- back-compat shim for in-flight CF Workflow instances serialized before #906
        (rawInput as { shotId?: string }).shotId ??
        undefined,
    };
    const workflowRunId = event.instanceId;

    if (input.sceneSnapshot) {
      await step.do('validate-snapshot', async () => {
        const expected = input.snapshotInputHash ?? '';
        const recomputed = await computeImageWorkflowHashFromDto(input);
        if (recomputed !== expected) {
          throw new WorkflowValidationError(
            'snapshotInputHash does not match the inlined DTO; payload was tampered with or serialized inconsistently'
          );
        }
      });
    }

    const snapshotHash: string | null =
      input.sceneSnapshot && input.snapshotInputHash
        ? input.snapshotInputHash
        : null;

    const generationParams = await step.do(
      'set-generating-status',
      async (): Promise<ImageGenerationParams | null> => {
        if (!input.prompt.trim()) {
          throw new WorkflowValidationError(
            'Prompt is required for image generation'
          );
        }

        logger.info(
          `[ImageWorkflow:cf] Starting image generation for user ${input.userId}`
        );

        const model = input.model ?? DEFAULT_IMAGE_MODEL;

        if (input.shotId) {
          // Variant-only (#547) must not touch the live primary columns — read
          // the shot instead of stamping `imageModel`/`thumbnailStatus`, so
          // adding a model can't flip the primary or trip staleness. The
          // per-model `shot_variants` row (opened below) carries the in-flight
          // state instead.
          const shot = input.variantOnly
            ? await scopedDb.shots.getById(input.shotId)
            : await scopedDb.shots.update(
                input.shotId,
                {
                  thumbnailStatus: 'generating',
                  thumbnailWorkflowRunId: workflowRunId,
                  imageModel: model,
                },
                { throwOnMissing: false }
              );

          if (!shot) {
            logger.info(
              `[ImageWorkflow:cf] Shot ${input.shotId} was deleted, skipping`
            );
            return null;
          }

          if (
            shouldRecordUserEdit({
              userEditedPrompt: input.userEditedPrompt,
              prompt: input.prompt,
              currentPrompt: shot.imagePrompt,
            })
          ) {
            let userEditInputHash: string | null = null;
            let userEditAnalysisModel: string | null = null;
            try {
              if (shot.metadata && input.sequenceId) {
                const sequence = await scopedDb.sequences.getById(
                  input.sequenceId
                );
                if (sequence) {
                  const ctx = await loadNarrowShotPromptContext({
                    scopedDb,
                    sequence: {
                      id: sequence.id,
                      styleId: sequence.styleId,
                      aspectRatio: sequence.aspectRatio,
                      analysisModel: sequence.analysisModel,
                    },
                    scene: shot.metadata,
                  });
                  userEditInputHash = await computeVisualPromptInputHash(ctx);
                  userEditAnalysisModel = ctx.analysisModel;
                }
              }
            } catch (err) {
              logger.warn(
                `[ImageWorkflow:cf] Could not compute upstream hash for user-edit on shot ${input.shotId}; recording with null hash`,
                {
                  err,
                }
              );
            }

            await scopedDb.shotPromptVariants.write({
              shotId: input.shotId,
              promptType: 'visual',
              text: input.prompt,
              source: 'user-edit',
              inputHash: userEditInputHash,
              analysisModel: userEditAnalysisModel,
              createdBy: input.userId,
            });
          }

          if (input.sequenceId) {
            await scopedDb.shotVariants.upsert({
              shotId: input.shotId,
              sequenceId: input.sequenceId,
              variantType: 'image',
              model,
              status: 'generating',
              workflowRunId,
            });
          }

          await getGenerationChannel(input.sequenceId).emit(
            'generation.image:progress',
            {
              shotId: input.shotId,
              status: 'generating',
              model,
              // Variant-only (#547): don't flip the primary shot to
              // "generating" in cache — this run only fills a variant row.
              variantOnly: input.variantOnly,
            }
          );
        }

        return {
          model,
          prompt: buildReferenceImagePrompt(
            input.prompt,
            input.referenceImages ?? [],
            IMAGE_MODELS[model].maxPromptLength
          ).prompt,
          imageSize: input.imageSize ?? DEFAULT_IMAGE_SIZE,
          numImages: input.numImages ?? 1,
          seed: input.seed,
          referenceImageUrls:
            input.referenceImages?.map(
              (ref: ReferenceImageDescription) => ref.referenceImageUrl
            ) ?? [],
        } satisfies ImageGenerationParams;
      }
    );

    if (!generationParams) {
      return {
        imageUrl: '',
        shotId: input.shotId,
        sequenceId: input.sequenceId,
      };
    }

    // Generate the image. CF's default per-step retry handles content-flag and
    // transient errors (#881): a stochastic rejection clears on a fresh
    // same-model call; a deterministic content-checker hit exhausts the retries
    // and fails with its real message — recorded on the shot by onFailure and
    // surfaced in the failure banner.
    const imageResult = await step.do('generate-image', async (ctx) => {
      logger.info(
        `[ImageWorkflow:cf] Generating image ${input.shotId} with model ${generationParams.model} (attempt ${ctx.attempt})`
      );
      // `ctx.attempt` is 1 on the first run and increments on each CF retry —
      // surface that as in-flight retry state so the scenes UI shows
      // "Retrying…" instead of an indistinguishable hung spinner (#882). No
      // fixed denominator: this leans on CF's default retry budget (above), so
      // `maxAttempts` reflects the resolved config when present, else is omitted.
      if (ctx.attempt > 1 && input.shotId && input.sequenceId) {
        await getGenerationChannel(input.sequenceId).emit(
          'generation.image:progress',
          {
            shotId: input.shotId,
            status: 'generating',
            phase: 'retrying',
            attempt: ctx.attempt,
            ...(ctx.config.retries?.limit !== undefined && {
              maxAttempts: ctx.config.retries.limit + 1,
            }),
            model: generationParams.model,
            variantOnly: input.variantOnly,
          }
        );
      }
      return generateImageWithProvider(generationParams, { scopedDb });
    });

    const imageCostMicros = imageResult.metadata.cost ?? ZERO_MICROS;
    const { teamId, shotId, sequenceId } = input;
    if (imageCostMicros > 0 && teamId && !imageResult.metadata.usedOwnKey) {
      await step.do('deduct-credits', async () => {
        await deductWorkflowCredits({
          scopedDb,
          costMicros: imageCostMicros,
          usedOwnKey: imageResult.metadata.usedOwnKey,
          description: `Image generation (${generationParams.model})`,
          idempotencyKey: `${event.instanceId}:image`,
          metadata: {
            model: generationParams.model,
            shotId: input.shotId,
            sequenceId: input.sequenceId,
          },
          workflowName: 'ImageWorkflow:cf',
        });
      });
    }

    const generatedImageUrl = imageResult.imageUrls[0];
    if (!generatedImageUrl) {
      throw new Error('Image generation did not return any image URLs');
    }
    let imageUrl: string = generatedImageUrl;

    if (imageUrl && shotId && sequenceId && teamId && !input.skipStorage) {
      const upload = await step.do('upload-image', async () => {
        return uploadImageToStorage({
          imageUrl,
          teamId,
          sequenceId,
          shotId,
        });
      });

      const writeResult = await step.do('persist-result', async () => {
        const promptHash = input.prompt ? simpleHash(input.prompt) : null;
        const { model } = generationParams;

        const currentHash = snapshotHash
          ? await computeImageWorkflowHashCurrent(input, scopedDb)
          : null;

        const outcome = await persistImageResult({
          scopedDb,
          shotId,
          sequenceId,
          model,
          upload,
          snapshotHash,
          currentHash,
          promptHash,
          variantOnly: input.variantOnly,
          emit: async (event2, payload) => {
            await getGenerationChannel(sequenceId).emit(event2, payload);
          },
        });

        if (outcome.status === 'shot-deleted') {
          logger.info(
            `[ImageWorkflow:cf] Shot ${shotId} was deleted, skipping persist`
          );
          return null;
        }

        if (outcome.status === 'divergent' && snapshotHash) {
          logger.info(
            `[ImageWorkflow:cf] Diverged shot ${shotId}: snapshot=${snapshotHash.slice(0, 8)} current=${currentHash?.slice(0, 8)}; routed alternate to shot_variants`
          );
        } else {
          logger.info(`[ImageWorkflow:cf] Uploaded to storage: ${upload.path}`);
        }

        return { imageUrl: outcome.imageUrl };
      });
      if (writeResult) imageUrl = writeResult.imageUrl;
    } else if (imageUrl && shotId && input.skipStorage) {
      await step.do('store-preview-url', async () => {
        const updatedShot = await scopedDb.shots.update(
          shotId,
          {
            previewThumbnailUrl: imageUrl,
            thumbnailGeneratedAt: new Date(),
            thumbnailError: null,
          },
          { throwOnMissing: false }
        );

        if (!updatedShot) {
          logger.info(
            `[ImageWorkflow:cf] Shot ${shotId} was deleted, skipping preview update`
          );
          return;
        }

        if (sequenceId) {
          await getGenerationChannel(sequenceId).emit(
            'generation.image:progress',
            { shotId, previewThumbnailUrl: imageUrl }
          );
        }
      });
    }

    return { imageUrl, shotId, sequenceId };
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<ImageWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): Promise<void> {
    const input = event.payload;
    const previewMode = input.skipStorage;
    if (previewMode) return;

    if (!input.shotId || !input.teamId) return;

    // Variant-only (#547): leave the primary columns untouched on failure too —
    // only this model's variant row is flipped to `failed` below.
    if (!input.variantOnly) {
      await scopedDb.shots.update(
        input.shotId,
        { thumbnailStatus: 'failed', thumbnailError: error },
        { throwOnMissing: false }
      );
    }

    const model = input.model ?? DEFAULT_IMAGE_MODEL;
    if (input.sequenceId) {
      await scopedDb.shotVariants.updateByShotAndModel(
        input.shotId,
        'image',
        model,
        { status: 'failed', error }
      );

      try {
        await getGenerationChannel(input.sequenceId).emit(
          'generation.image:progress',
          {
            shotId: input.shotId,
            status: 'failed',
            model,
            // Carry the reason so the cache updater writes `thumbnailError`
            // live — otherwise the FailureSummaryBanner shows "Unknown error"
            // until a full refetch (#881). Skip for variant-only (the primary
            // row isn't touched).
            ...(input.variantOnly ? {} : { error }),
            // Variant-only (#547): a failed alternate must not flip the primary
            // thumbnail to "failed" in cache (the DB write above is already
            // guarded on variantOnly).
            variantOnly: input.variantOnly,
          }
        );
      } catch (emitError) {
        logger.error(
          `[ImageWorkflow:cf] Failed to emit failure event for sequence ${input.sequenceId} shot ${input.shotId}:`,
          {
            err: emitError,
          }
        );
      }
    }

    if (isContentRejectionError(error)) {
      logger.warn(
        `[ImageWorkflow:cf] shot ${input.shotId} failed a content checker`,
        {
          event: CONTENT_REJECTION_EVENT,
          kind: 'image',
          model,
          shotId: input.shotId,
          sequenceId: input.sequenceId,
          error,
        }
      );
    }

    logger.error(
      `[ImageWorkflow:cf] Image generation failed for shot ${input.shotId}: ${error}`
    );
  }
}
