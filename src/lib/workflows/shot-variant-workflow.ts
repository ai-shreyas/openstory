/**
 * Shot variant (3×3 grid) workflow — generates the composition-picker SHEET.
 *
 * #989: the sheet is no longer a `shots.variantImageUrl` column. It is a
 * `frame_variants` version with `kind:'framing'` and `sourceVariantId = NULL`
 * (the raw grid; a chosen tile later points its `sourceVariantId` at this
 * sheet). The picker reads the latest such version. The sheet is never
 * "selected" — it's only the source the tiles are cropped from.
 */

import { DEFAULT_IMAGE_MODEL, IMAGE_MODELS } from '@/lib/ai/models';
import {
  deductWorkflowCredits,
  extractImageCost,
  falUsageMetadata,
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

type PrepResult = { params: ImageGenerationParams; versionId: string };

export class ShotVariantWorkflow extends OpenStoryWorkflowEntrypoint<ShotVariantWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<ShotVariantWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<ShotVariantWorkflowResult> {
    const input = event.payload;
    const workflowRunId = event.instanceId;

    const prep = await step.do(
      'set-generating-status',
      async (): Promise<PrepResult | null> => {
        if (!input.thumbnailUrl || input.thumbnailUrl.trim().length === 0) {
          throw new WorkflowValidationError(
            'Source still URL is required for variant grid generation'
          );
        }

        logger.info(
          `[ShotVariantWorkflow] Starting variant grid generation for user ${input.userId}`
        );

        const model = input.model || DEFAULT_IMAGE_MODEL;
        const gridConfig = input.aspectRatio
          ? getVariantGridConfig(input.aspectRatio)
          : null;
        const imageSize =
          gridConfig?.imageSize ?? input.imageSize ?? DEFAULT_IMAGE_SIZE;

        const basePrompt = getVariantImagePrompt(
          imageSize,
          input.scenePrompt,
          gridConfig
            ? { cols: gridConfig.cols, rows: gridConfig.rows }
            : undefined
        );

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

        const params: ImageGenerationParams = {
          model,
          prompt: enhancedPrompt,
          imageSize,
          numImages: input.numImages ?? 1,
          seed: input.seed,
          referenceImageUrls: referenceUrls,
          traceName: 'variant-image',
        };

        // No frame to attach the sheet to (deleted mid-flight) → skip.
        if (!input.shotId || !input.sequenceId) {
          return { params, versionId: '' };
        }
        const frame = await scopedDb.frames.getAnchorByShot(input.shotId);
        if (!frame) {
          logger.info(
            `[ShotVariantWorkflow] Shot ${input.shotId} has no anchor frame, skipping`
          );
          return null;
        }

        const version = await scopedDb.frameVariants.appendVersion({
          frameId: frame.id,
          sequenceId: input.sequenceId,
          kind: 'framing',
          model,
          sourceVariantId: null,
          status: 'generating',
          workflowRunId,
        });

        await getGenerationChannel(input.sequenceId).emit(
          'generation.variant-image:progress',
          { shotId: input.shotId, status: 'generating' }
        );

        return { params, versionId: version.id };
      }
    );

    if (!prep) {
      return { variantImageUrl: '' };
    }

    const imageResult = await step.do('generate-image', async () => {
      logger.info(
        `[ShotVariantWorkflow] Generating variant grid ${input.shotId} with model ${prep.params.model}`
      );
      return generateImageWithProvider(prep.params, { scopedDb });
    });

    await step.do('deduct-credits', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: extractImageCost(imageResult.metadata),
        usedOwnKey: imageResult.metadata.usedOwnKey,
        description: `Variant grid generation (${prep.params.model})`,
        idempotencyKey: `${event.instanceId}:variant-image`,
        falUsage: falUsageMetadata(imageResult.metadata),
        metadata: {
          ...falUsageMetadata(imageResult.metadata),
          model: prep.params.model,
          shotId: input.shotId,
          sequenceId: input.sequenceId,
        },
        workflowName: 'ShotVariantWorkflow',
      });
    });

    const generatedImageUrl = imageResult.imageUrls[0];
    if (!generatedImageUrl) {
      throw new Error('Image generation did not return any image URLs');
    }
    let imageUrl: string = generatedImageUrl;

    if (input.shotId && input.sequenceId && input.teamId && prep.versionId) {
      const uploadResult = await step.do('upload-to-storage', async () => {
        if (!input.shotId || !input.sequenceId || !input.teamId) {
          throw new Error('Missing required IDs for storage upload');
        }
        const result = await uploadImageToStorage({
          imageUrl: generatedImageUrl,
          teamId: input.teamId,
          sequenceId: input.sequenceId,
          shotId: input.shotId,
        });
        if (!result.url) {
          throw new Error('Failed to upload image to storage');
        }

        // Complete the framing-sheet version. No selection — the sheet is the
        // picker source, not the frame's primary still.
        await scopedDb.frameVariants.update(prep.versionId, {
          status: 'completed',
          url: result.url,
          storagePath: result.path || null,
          generatedAt: new Date(),
          error: null,
        });

        await getGenerationChannel(input.sequenceId).emit(
          'generation.variant-image:progress',
          {
            shotId: input.shotId,
            status: 'completed',
            variantImageUrl: result.url,
          }
        );

        logger.info(
          `[ShotVariantWorkflow] Grid sheet uploaded: ${result.path}`
        );
        return { url: result.url };
      });

      if (uploadResult.url) imageUrl = uploadResult.url;
    }

    return { variantImageUrl: imageUrl };
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
    if (!input.shotId || !input.teamId) return;

    await scopedDb.frameVariants.markFailedByWorkflowRun(
      event.instanceId,
      error
    );

    if (input.sequenceId) {
      try {
        await getGenerationChannel(input.sequenceId).emit(
          'generation.variant-image:progress',
          { shotId: input.shotId, status: 'failed' }
        );
      } catch {
        // Ignore emit errors
      }
    }

    logger.error(
      `[ShotVariantWorkflow] Variant grid generation failed for shot ${input.shotId}: ${error}`
    );
  }
}
