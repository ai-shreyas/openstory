/**
 * Cloudflare Workflows port of `generateShotVariantWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/shot-variant-workflow.ts`)
 * step for step — same step names, same control flow, same side effects.
 * The only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads the workflow run id from `event.instanceId` instead of
 *     `context.workflowRunId`. */

import { DEFAULT_IMAGE_MODEL, IMAGE_MODELS } from '@/lib/ai/models';
import {
  deductWorkflowCredits,
  extractImageCost,
} from '@/lib/billing/workflow-deduction';
import {
  DEFAULT_IMAGE_SIZE,
  getVariantGridConfig,
} from '@/lib/constants/aspect-ratios';
import type { ScopedDb } from '@/lib/db/scoped';
import {
  generateImageWithProvider,
  type ImageGenerationParams,
} from '@/lib/image/image-generation';
import { uploadImageToStorage } from '@/lib/image/image-storage';
import {
  buildReferenceImagePrompt,
  type ReferenceImageDescription,
} from '@/lib/prompts/reference-image-prompt';
import { getVariantImagePrompt } from '@/lib/prompts/variant-image';
import { getGenerationChannel } from '@/lib/realtime';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type {
  ShotVariantWorkflowInput,
  ShotVariantWorkflowResult,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'shot-variant']);

export class ShotVariantWorkflow extends OpenStoryWorkflowEntrypoint<ShotVariantWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<ShotVariantWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<ShotVariantWorkflowResult> {
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

    // Step 1: Set status to generating if shotId is provided
    const generationParams = await step.do(
      'set-generating-status',
      async (): Promise<ImageGenerationParams | null> => {
        // Validate required fields
        if (!input.thumbnailUrl || input.thumbnailUrl.trim().length === 0) {
          throw new WorkflowValidationError(
            'Thumbnail URL is required for variant image generation'
          );
        }

        logger.info(
          `[ShotVariantWorkflow:cf] Starting variant image generation workflow for user ${input.userId}`
        );

        const model = input.model || DEFAULT_IMAGE_MODEL;
        const gridConfig = input.aspectRatio
          ? getVariantGridConfig(input.aspectRatio)
          : null;
        const imageSize =
          gridConfig?.imageSize ?? input.imageSize ?? DEFAULT_IMAGE_SIZE;

        if (input.shotId) {
          // update shot status to generating and store user prompt
          const shot = await scopedDb.shots.update(
            input.shotId,
            {
              variantImageStatus: 'generating',
              variantWorkflowRunId: workflowRunId,
            },
            { throwOnMissing: false }
          );

          if (!shot) {
            logger.info(
              `[ShotVariantWorkflow:cf] Shot ${input.shotId} was deleted, skipping workflow`
            );
            return null; // Signal to skip
          }

          // Dual-write: update shot variant status on shot_variants row (returns null if row doesn't exist)
          if (input.sequenceId) {
            await scopedDb.shotVariants.updateByShotAndModel(
              input.shotId,
              'image',
              model,
              {
                shotVariantStatus: 'generating',
                shotVariantWorkflowRunId: workflowRunId,
              }
            );
          }

          // Emit realtime progress
          await getGenerationChannel(input.sequenceId).emit(
            'generation.variant-image:progress',
            {
              shotId: input.shotId,
              status: 'generating',
            }
          );
        }

        // Build prompt with scene context and grid layout
        const basePrompt = getVariantImagePrompt(
          imageSize,
          input.scenePrompt,
          gridConfig
            ? { cols: gridConfig.cols, rows: gridConfig.rows }
            : undefined
        );

        // ALL references go through buildReferenceImagePrompt so each URL is labeled in the prompt
        const allReferences: ReferenceImageDescription[] = [
          {
            referenceImageUrl: input.thumbnailUrl,
            description: `Primary source scene — generate ${gridConfig?.count ?? 9} variant shots from this image`,
            role: 'primary',
          },
          ...(input.characterReferences ?? []),
          ...(input.locationReferences ?? []),
          ...(input.elementReferences ?? []),
        ];

        const { prompt: enhancedPrompt, referenceUrls } =
          buildReferenceImagePrompt(
            basePrompt,
            allReferences,
            IMAGE_MODELS[model].maxPromptLength
          );

        // Return the generation params so it shows in the workflow context for debugging
        return {
          model,
          prompt: enhancedPrompt,
          imageSize,
          numImages: input.numImages ?? 1,
          seed: input.seed,
          referenceImageUrls: referenceUrls,
        } satisfies ImageGenerationParams;
      }
    );

    // Early exit if shot was deleted
    if (!generationParams) {
      return { variantImageUrl: '' };
    }

    // Step 2: Generate image
    const imageResult = await step.do('generate-image', async () => {
      logger.info(
        `[ShotVariantWorkflow:cf] Generating variant image ${input.shotId} with model ${generationParams.model}`
      );

      return await generateImageWithProvider(generationParams, { scopedDb });
    });

    // Deduct credits for image generation (skip if team used own fal key)
    await step.do('deduct-credits', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: extractImageCost(imageResult.metadata),
        usedOwnKey: imageResult.metadata.usedOwnKey,
        description: `Variant image generation (${generationParams.model})`,
        idempotencyKey: `${event.instanceId}:variant-image`,
        metadata: {
          model: generationParams.model,
          shotId: input.shotId,
          sequenceId: input.sequenceId,
        },
        workflowName: 'ShotVariantWorkflow:cf',
      });
    });

    const generatedImageUrl = imageResult.imageUrls[0];
    if (!generatedImageUrl) {
      throw new Error('Image generation did not return any image URLs');
    }
    let imageUrl: string = generatedImageUrl;

    if (input.shotId && input.sequenceId && input.teamId) {
      const uploadResult = await step.do('upload-to-storage', async () => {
        if (
          !input.shotId ||
          !input.sequenceId ||
          !input.teamId ||
          !imageResult.imageUrls[0]
        ) {
          throw new Error('Missing required IDs for storage upload', {
            cause: JSON.stringify(imageResult),
          });
        }

        const result = await uploadImageToStorage({
          imageUrl: imageResult.imageUrls[0],
          teamId: input.teamId,
          sequenceId: input.sequenceId,
          shotId: input.shotId,
        });

        if (!result.url) {
          throw new Error('Failed to upload image to storage');
        }

        const updatedShot = await scopedDb.shots.update(
          input.shotId,
          {
            variantImageUrl: result.url, // Store public URL (permanent, not signed)
            variantImageStatus: 'completed',
          },
          { throwOnMissing: false }
        );

        if (!updatedShot) {
          logger.info(
            `[ShotVariantWorkflow:cf] Shot ${input.shotId} was deleted, skipping final update`
          );
          return { url: result.url, path: result.path };
        }

        // Dual-write: update shot variant on shot_variants row (returns null if row doesn't exist)
        const variantModel = input.model || DEFAULT_IMAGE_MODEL;
        await scopedDb.shotVariants.updateByShotAndModel(
          input.shotId,
          'image',
          variantModel,
          {
            shotVariantUrl: result.url,
            shotVariantPath: result.path || null,
            shotVariantStatus: 'completed',
          }
        );

        // Emit completion progress
        await getGenerationChannel(input.sequenceId).emit(
          'generation.variant-image:progress',
          {
            shotId: input.shotId,
            status: 'completed',
            variantImageUrl: result.url,
          }
        );

        logger.info(
          `[ShotVariantWorkflow:cf] Image uploaded to storage: ${result.path}`
        );
        return { url: result.url, path: result.path };
      });

      if (uploadResult.url) {
        imageUrl = uploadResult.url;
      }
    }

    // Return workflow result
    return {
      variantImageUrl: imageUrl,
    };
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<ShotVariantWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): Promise<void> {
    const input = event.payload;

    // Set shot variant status to 'failed' after all retries exhausted
    if (input.shotId && input.teamId) {
      await scopedDb.shots.update(
        input.shotId,
        {
          variantImageStatus: 'failed',
          variantImageError: error,
        },
        { throwOnMissing: false }
      );

      // Dual-write: update shot variant status on shot_variants row (returns null if row doesn't exist)
      const model = input.model || DEFAULT_IMAGE_MODEL;
      if (input.sequenceId) {
        await scopedDb.shotVariants.updateByShotAndModel(
          input.shotId,
          'image',
          model,
          { shotVariantStatus: 'failed' }
        );
      }

      // Emit failure progress
      if (input.sequenceId) {
        try {
          await getGenerationChannel(input.sequenceId).emit(
            'generation.variant-image:progress',
            {
              shotId: input.shotId,
              status: 'failed',
            }
          );
        } catch {
          // Ignore emit errors
        }
      }

      logger.error(
        `[ShotVariantWorkflow:cf] Image generation failed for shot ${input.shotId}: ${error}`
      );
    }
  }
}
