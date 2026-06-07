/**
 * Cloudflare Workflows port of `libraryLocationSheetWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/library-location-sheet-workflow.ts`)
 * step for step — same step names, same control flow, same side effects. The
 * only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads payload from `event.payload` instead of `context.requestPayload`. */

import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import {
  deductWorkflowCredits,
  extractImageCost,
} from '@/lib/billing/workflow-deduction';
import { generateId } from '@/lib/db/id';
import type { ScopedDb } from '@/lib/db/scoped';
import {
  generateImageWithProvider,
  type ImageGenerationParams,
} from '@/lib/image/image-generation';
import {
  buildLibraryLocationSheetPrompt,
  buildLocationPreviewPrompt,
} from '@/lib/prompts/location-prompt';
import { getLocationChannel } from '@/lib/realtime';
import { STORAGE_BUCKETS } from '@/lib/storage/buckets';
import { uploadResponse } from '@/lib/storage/upload-response';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import type {
  LibraryLocationSheetWorkflowInput,
  LibraryLocationSheetWorkflowResult,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'library-location-sheet']);

export class LibraryLocationSheetWorkflow extends OpenStoryWorkflowEntrypoint<LibraryLocationSheetWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<LibraryLocationSheetWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<LibraryLocationSheetWorkflowResult> {
    const input = event.payload;

    // Emit generating status
    await step.do('emit-generating', async () => {
      await getLocationChannel(input.locationDbId).emit(
        'location.sheet:progress',
        {
          locationId: input.locationDbId,
          status: 'generating',
        }
      );
    });

    // Step 1: Build the prompt
    const generationParams: ImageGenerationParams = await step.do(
      'build-prompt',
      async () => {
        logger.info(
          `[LibraryLocationSheetWorkflow:cf] Starting sheet generation for location ${input.locationName} with ${input.referenceImageUrls.length} reference images`
        );

        const { prompt, referenceUrls } = buildLibraryLocationSheetPrompt(
          input.locationName,
          input.locationDescription,
          input.referenceImageUrls
        );

        const model = input.imageModel ?? DEFAULT_IMAGE_MODEL;

        return {
          model,
          prompt,
          // 3x3 grid in landscape format
          imageSize: 'landscape_16_9' as const,
          numImages: 1,
          referenceImageUrls:
            referenceUrls.length > 0 ? referenceUrls : undefined,
        } satisfies ImageGenerationParams;
      }
    );

    // Step 2: Generate the location sheet image
    const imageResult = await step.do('generate-sheet-image', async () => {
      logger.info(
        `[LibraryLocationSheetWorkflow:cf] Generating 3x3 grid sheet for ${input.locationName} with model ${generationParams.model}`
      );

      return generateImageWithProvider(generationParams, { scopedDb });
    });

    // Deduct credits for image generation (skip if team used own fal key)
    await step.do('deduct-credits-sheet', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: extractImageCost(imageResult.metadata),
        usedOwnKey: imageResult.metadata.usedOwnKey,
        description: `Library location sheet (${generationParams.model})`,
        idempotencyKey: `${event.instanceId}:sheet`,
        metadata: {
          model: generationParams.model,
          locationName: input.locationName,
          locationDbId: input.locationDbId,
        },
        workflowName: 'LibraryLocationSheetWorkflow',
      });
    });

    // Step 3: Upload sheet to R2 storage
    const storageResult = await step.do('upload-to-storage', async () => {
      const imageUrl = imageResult.imageUrls[0];
      if (!imageUrl) {
        throw new Error('No image URL returned from generation');
      }

      logger.info(
        `[LibraryLocationSheetWorkflow:cf] Uploading sheet to storage for ${input.locationName}`
      );

      // Fetch and stream directly to R2
      const response = await fetch(imageUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch generated image: ${response.status}`);
      }

      // Build storage path: locations/{teamId}/{sequenceId}/{locationDbId}/sheet_{uniqueId}.png
      const uniqueId = generateId();
      const storagePath = `${input.teamId}/${input.sequenceId}/${input.locationDbId}/sheet_${uniqueId}.png`;

      const result = await uploadResponse(
        response,
        STORAGE_BUCKETS.LOCATIONS,
        storagePath,
        {
          contentType: 'image/png',
        }
      );

      return {
        url: result.publicUrl,
        path: result.path,
      };
    });

    // Step 4: Update database with the generated sheet
    await step.do('update-database', async () => {
      logger.info(
        `[LibraryLocationSheetWorkflow:cf] Updating database for ${input.locationName}`
      );

      await scopedDb.locations.updateReference(
        input.locationDbId,
        storageResult.url,
        storageResult.path
      );
    });

    // Step 5: Generate preview establishing shot for card thumbnail
    const hasReferenceImages = input.referenceImageUrls.length > 0;
    const previewResult = await step.do('generate-preview-image', async () => {
      const model = input.imageModel ?? DEFAULT_IMAGE_MODEL;
      const prompt = buildLocationPreviewPrompt(
        input.locationName,
        input.locationDescription,
        hasReferenceImages
      );

      logger.info(
        `[LibraryLocationSheetWorkflow:cf] Generating preview establishing shot for ${input.locationName}`
      );

      const previewParams: ImageGenerationParams = {
        model,
        prompt,
        imageSize: 'landscape_16_9',
        numImages: 1,
      } satisfies ImageGenerationParams;

      if (hasReferenceImages) {
        previewParams.referenceImageUrls = input.referenceImageUrls;
      }

      return generateImageWithProvider(previewParams, { scopedDb });
    });

    // Deduct credits for preview generation
    await step.do('deduct-credits-preview', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: extractImageCost(previewResult.metadata),
        usedOwnKey: previewResult.metadata.usedOwnKey,
        description: `Location preview (${input.imageModel ?? DEFAULT_IMAGE_MODEL})`,
        idempotencyKey: `${event.instanceId}:preview`,
        metadata: { locationDbId: input.locationDbId, type: 'preview' },
        workflowName: 'LibraryLocationSheetWorkflow',
      });
    });

    const previewUrl = previewResult.imageUrls[0];
    if (!previewUrl) {
      throw new Error('No preview URL returned from generation');
    }

    // Step 6: Upload preview to R2 storage
    const previewStorageResult = await step.do(
      'upload-preview-to-storage',
      async () => {
        logger.info(
          `[LibraryLocationSheetWorkflow:cf] Uploading preview to storage for ${input.locationName}`
        );

        const response = await fetch(previewUrl);
        if (!response.ok) {
          throw new Error(
            `Failed to fetch generated preview: ${response.status}`
          );
        }

        const previewPath = `${input.teamId}/${input.sequenceId}/${input.locationDbId}/preview.png`;

        const result = await uploadResponse(
          response,
          STORAGE_BUCKETS.LOCATIONS,
          previewPath,
          { contentType: 'image/png' }
        );

        return {
          url: result.publicUrl,
          path: result.path,
        };
      }
    );

    // Step 7: Update location with preview as the referenceImageUrl
    await step.do('update-location-preview', async () => {
      logger.info(
        `[LibraryLocationSheetWorkflow:cf] Updating location with preview image`
      );

      await scopedDb.locations.updateReference(
        input.locationDbId,
        previewStorageResult.url,
        previewStorageResult.path
      );
    });

    // Emit completed status
    await step.do('emit-completed', async () => {
      logger.info(
        `[LibraryLocationSheetWorkflow:cf] Library location sheet workflow completed for ${input.locationName}`
      );

      await getLocationChannel(input.locationDbId).emit(
        'location.sheet:progress',
        {
          locationId: input.locationDbId,
          status: 'completed',
          sheetImageUrl: storageResult.url,
        }
      );
    });

    const result: LibraryLocationSheetWorkflowResult = {
      sheetImageUrl: storageResult.url,
      sheetImagePath: storageResult.path,
      previewImageUrl: previewStorageResult.url,
      previewImagePath: previewStorageResult.path,
      locationDbId: input.locationDbId,
    };

    return result;
  }

  protected override async onFailure({
    event,
    error,
  }: {
    event: Readonly<WorkflowEvent<LibraryLocationSheetWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): Promise<void> {
    const input = event.payload;

    logger.error(
      `[LibraryLocationSheetWorkflow:cf] Sheet generation failed for location ${input.locationName}: ${error}`
    );

    try {
      await getLocationChannel(input.locationDbId).emit(
        'location.sheet:progress',
        {
          locationId: input.locationDbId,
          status: 'failed',
          error: `Sheet generation failed: ${error}`,
        }
      );
    } catch (emitError) {
      logger.error(
        `[LibraryLocationSheetWorkflow:cf] Failed to emit failure event for location ${input.locationDbId}:`,
        {
          err: emitError,
        }
      );
    }
  }
}
