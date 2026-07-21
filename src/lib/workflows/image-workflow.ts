/**
 * Image generation workflow (#989: writes to `frames` / `frame_variants`).
 *
 * The still image is the FRAME's surface now. Each run:
 *   1. set-generating-status — flips the anchor frame to 'generating', records a
 *      user-edited prompt as a `frame_prompt_versions` row, and APPENDS an
 *      in-flight `frame_variants` version (kind='model').
 *   2. generate-image / deduct-credits / upload-image — unchanged.
 *   3. persist-result — completes the version, emits `image.generated`, then
 *      SELECT-OR-NOT: a new selection is a pointer repoint
 *      (`frameVariants.select`, which mirrors + emits `image.selected`), never an
 *      overwrite. `variantOnly` (adding a model) appends without selecting; a
 *      mid-flight input drift (snapshot ≠ current) appends a retained,
 *      stale-flagged version without repointing the primary. The old
 *      divergent-alternate machinery (`persistImageResult` / `divergedAt`) is
 *      retired — divergence is just "a version you didn't select".
 */

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
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import {
  computeImageWorkflowHashCurrent,
  computeImageWorkflowHashFromDto,
} from '@/lib/workflows/image-workflow-snapshot';
import { shouldRecordUserEdit } from '@/lib/workflows/user-edit-predicate';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'image']);

type ImageWorkflowResult = {
  imageUrl: string;
  shotId?: string;
  sequenceId?: string;
};

/** Output of `set-generating-status`: the generation params plus the id of the
 * in-flight `frame_variants` version it appended (empty when there's no frame
 * context, e.g. preview mode or a shotless ad-hoc generation). */
type PrepResult = {
  params: ImageGenerationParams;
  versionId: string;
};

export class ImageWorkflow extends OpenStoryWorkflowEntrypoint<ImageWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<ImageWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<ImageWorkflowResult> {
    const input = event.payload;
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

    const prep = await step.do(
      'set-generating-status',
      async (): Promise<PrepResult | null> => {
        if (!input.prompt.trim()) {
          throw new WorkflowValidationError(
            'Prompt is required for image generation'
          );
        }

        logger.info(
          `[ImageWorkflow] Starting image generation for user ${input.userId}`
        );

        const model = input.model ?? DEFAULT_IMAGE_MODEL;
        // The builder orders the URLs to match the prompt's Image numbering
        // (primary → characters → locations → elements) — always send its
        // referenceUrls, not the raw input order.
        const { prompt: enhancedPrompt, referenceUrls } =
          buildReferenceImagePrompt(
            input.prompt,
            input.referenceImages ?? [],
            IMAGE_MODELS[model].maxPromptLength
          );
        const params: ImageGenerationParams = {
          model,
          prompt: enhancedPrompt,
          imageSize: input.imageSize ?? DEFAULT_IMAGE_SIZE,
          numImages: input.numImages ?? 1,
          seed: input.seed,
          referenceImageUrls: referenceUrls,
          traceName: 'shot-image',
        };

        // No frame context (preview mode, or shotless ad-hoc): generate without
        // touching the DB — no version, no status flip. The caller stores the
        // preview URL on the frame in the skipStorage branch below.
        if (!input.shotId || !input.sequenceId || input.skipStorage) {
          return { params, versionId: '' };
        }

        const frame = await scopedDb.frames.getAnchorByShot(input.shotId);
        if (!frame) {
          logger.info(
            `[ImageWorkflow] Shot ${input.shotId} has no anchor frame (deleted?), skipping`
          );
          return null;
        }

        if (
          shouldRecordUserEdit({
            userEditedPrompt: input.userEditedPrompt,
            prompt: input.prompt,
            currentPrompt: frame.imagePrompt,
          })
        ) {
          let userEditInputHash: string | null = null;
          let userEditAnalysisModel: string | null = null;
          try {
            const shot = await scopedDb.shots.getById(input.shotId);
            if (shot?.metadata) {
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
              `[ImageWorkflow] Could not compute upstream hash for user-edit on frame ${input.shotId}; recording with null hash`,
              { err }
            );
          }

          await scopedDb.framePromptVersions.write({
            frameId: frame.id,
            text: input.prompt,
            source: 'user-edit',
            inputHash: userEditInputHash,
            analysisModel: userEditAnalysisModel,
            createdBy: input.userId,
          });
        }

        // Variant-only (adding a model) must not flip the primary frame to
        // 'generating' — only this model's new version carries the in-flight
        // state, so the picker can't trip staleness on the live selection.
        if (!input.variantOnly) {
          await scopedDb.frames.setImageGenerationStatus(
            frame.id,
            {
              imageStatus: 'generating',
              imageWorkflowRunId: workflowRunId,
              imageModel: model,
            },
            { throwOnMissing: false }
          );
        }

        const version = await scopedDb.frameVariants.appendVersion({
          frameId: frame.id,
          sequenceId: input.sequenceId,
          kind: 'model',
          model,
          status: 'generating',
          workflowRunId,
        });

        await getGenerationChannel(input.sequenceId).emit(
          'generation.image:progress',
          {
            shotId: input.shotId,
            status: 'generating',
            model,
            variantOnly: input.variantOnly,
          }
        );

        return { params, versionId: version.id };
      }
    );

    if (!prep) {
      return {
        imageUrl: '',
        shotId: input.shotId,
        sequenceId: input.sequenceId,
      };
    }

    // Generate the image. CF's default per-step retry handles content-flag and
    // transient errors (#881): a stochastic rejection clears on a fresh
    // same-model call; a deterministic content-checker hit exhausts the retries
    // and fails with its real message — recorded on the frame by onFailure.
    const imageResult = await step.do('generate-image', async (ctx) => {
      logger.info(
        `[ImageWorkflow] Generating image ${input.shotId} with model ${prep.params.model} (attempt ${ctx.attempt})`
      );
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
            model: prep.params.model,
            variantOnly: input.variantOnly,
          }
        );
      }
      return generateImageWithProvider(prep.params, { scopedDb });
    });

    const imageCostMicros = imageResult.metadata.cost ?? ZERO_MICROS;
    const { teamId, shotId, sequenceId } = input;
    if (imageCostMicros > 0 && teamId && !imageResult.metadata.usedOwnKey) {
      await step.do('deduct-credits', async () => {
        await deductWorkflowCredits({
          scopedDb,
          costMicros: imageCostMicros,
          usedOwnKey: imageResult.metadata.usedOwnKey,
          description: `Image generation (${prep.params.model})`,
          idempotencyKey: `${event.instanceId}:image`,
          metadata: {
            model: prep.params.model,
            shotId: input.shotId,
            sequenceId: input.sequenceId,
          },
          workflowName: 'ImageWorkflow',
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
        return uploadImageToStorage({ imageUrl, teamId, sequenceId, shotId });
      });

      const writeResult = await step.do('persist-result', async () => {
        const promptHash = input.prompt ? simpleHash(input.prompt) : null;
        const { model } = prep.params;
        const versionId = prep.versionId;

        // Resolve the anchor frame (frame id ≠ shot id, #989) for the event
        // target + selection repoint below.
        const frame = await scopedDb.frames.getAnchorByShot(shotId);
        if (!frame) {
          logger.info(
            `[ImageWorkflow] Shot ${shotId} lost its anchor frame before select; skipping`
          );
          return { imageUrl: upload.url };
        }

        // Complete the in-flight version. Its inputHash IS the snapshot hash —
        // staleness of this version is its own concern (immutable once done).
        await scopedDb.frameVariants.update(versionId, {
          status: 'completed',
          url: upload.url,
          storagePath: upload.path,
          previewUrl: null,
          generatedAt: new Date(),
          error: null,
          promptHash,
          inputHash: snapshotHash,
        });

        await scopedDb.sequenceEvents.record({
          sequenceId,
          actorId: input.userId,
          kind: 'image.generated',
          targetType: 'frame',
          targetId: frame.id,
          summary: `Generated ${model} image`,
          data: { versionId, model, variantOnly: input.variantOnly ?? false },
        });

        const channel = getGenerationChannel(sequenceId);

        // Adding a model — leave the primary selection untouched.
        if (input.variantOnly) {
          await channel.emit('generation.image:progress', {
            shotId,
            status: 'completed',
            thumbnailUrl: upload.url,
            model,
            variantOnly: true,
          });
          return { imageUrl: upload.url };
        }

        // Mid-flight input drift: keep the version (stale-flagged via its
        // inputHash) but DON'T repoint — the prior selection stays the primary.
        const currentHash = snapshotHash
          ? await computeImageWorkflowHashCurrent(input, scopedDb)
          : null;
        if (snapshotHash && currentHash !== snapshotHash) {
          logger.info(
            `[ImageWorkflow] Frame ${shotId} drifted (snapshot=${snapshotHash.slice(0, 8)} current=${currentHash?.slice(0, 8)}); retained version ${versionId} unselected`
          );
          // Reset the frame's in-flight status to a TERMINAL value — otherwise it
          // stays 'generating' forever (the only path that clears it is
          // `select`, which drift intentionally skips), leaving a perpetual
          // spinner over the prior good still. The mirror/selection are
          // untouched, so the prior selection (if any) remains the primary: a
          // frame with a prior selection settles back to 'completed', a
          // never-selected frame to 'pending'. Mirrors the reset the retired
          // `buildDivergentRevertWrites` used to guarantee.
          const driftStatus = frame.selectedImageVersionId
            ? 'completed'
            : 'pending';
          await scopedDb.frames.setImageGenerationStatus(
            frame.id,
            {
              imageStatus: driftStatus,
              imageWorkflowRunId: null,
              imageError: null,
            },
            { throwOnMissing: false }
          );
          await channel.emit('generation.image:progress', {
            shotId,
            status: driftStatus,
            model,
          });
          return { imageUrl: upload.url };
        }

        // Select = pointer repoint + mirror + `image.selected` event (atomic).
        await scopedDb.frameVariants.select(frame.id, versionId, {
          actorId: input.userId,
        });
        // A new still invalidates the shot's downstream video (still on `shots`
        // until Phase 3) — reset it so the user regenerates motion.
        await scopedDb.shots.update(
          shotId,
          {
            videoUrl: null,
            videoPath: null,
            videoStatus: 'pending',
            videoWorkflowRunId: null,
            videoGeneratedAt: null,
            videoError: null,
          },
          { throwOnMissing: false }
        );
        await channel.emit('generation.image:progress', {
          shotId,
          status: 'completed',
          thumbnailUrl: upload.url,
          model,
        });
        logger.info(`[ImageWorkflow] Uploaded + selected: ${upload.path}`);
        return { imageUrl: upload.url };
      });
      imageUrl = writeResult.imageUrl;
    } else if (imageUrl && shotId && input.skipStorage) {
      await step.do('store-preview-url', async () => {
        const anchor = await scopedDb.frames.getAnchorByShot(shotId);
        const updatedFrame = anchor
          ? await scopedDb.frames.setImageGenerationStatus(
              anchor.id,
              {
                previewImageUrl: imageUrl,
                imageGeneratedAt: new Date(),
                imageError: null,
              },
              { throwOnMissing: false }
            )
          : null;

        if (!updatedFrame) {
          logger.info(
            `[ImageWorkflow] Shot ${shotId} has no anchor frame, skipping preview update`
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
    if (input.skipStorage) return;
    if (!input.shotId || !input.teamId) return;

    // Variant-only: leave the primary frame untouched on failure too — only
    // this model's in-flight version flips to 'failed' below.
    if (!input.variantOnly) {
      const anchor = await scopedDb.frames.getAnchorByShot(input.shotId);
      if (anchor) {
        await scopedDb.frames.setImageGenerationStatus(
          anchor.id,
          { imageStatus: 'failed', imageError: error },
          { throwOnMissing: false }
        );
      }
    }
    await scopedDb.frameVariants.markFailedByWorkflowRun(
      event.instanceId,
      error
    );

    const model = input.model ?? DEFAULT_IMAGE_MODEL;
    if (input.sequenceId) {
      try {
        await getGenerationChannel(input.sequenceId).emit(
          'generation.image:progress',
          {
            shotId: input.shotId,
            status: 'failed',
            model,
            ...(input.variantOnly ? {} : { error }),
            variantOnly: input.variantOnly,
          }
        );
      } catch (emitError) {
        logger.error(
          `[ImageWorkflow] Failed to emit failure event for sequence ${input.sequenceId} shot ${input.shotId}:`,
          { err: emitError }
        );
      }
    }

    if (isContentRejectionError(error)) {
      logger.warn(
        `[ImageWorkflow] frame ${input.shotId} failed a content checker`,
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
      `[ImageWorkflow] Image generation failed for frame ${input.shotId}: ${error}`
    );
  }
}
