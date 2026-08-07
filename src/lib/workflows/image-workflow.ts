/**
 * Image generation workflow (#989: writes to `frames` / `frame_variants`).
 *
 * The still image is the FRAME's surface now. Each run:
 *   1. set-generating-status — claim-or-append a `frame_variants` version, then
 *      (unless variantOnly) flip the primary frame to 'generating'. With
 *      `targetVariantId` (#1085) a pre-created pending claim is transitioned
 *      in place via `claimForGeneration` (no append). Without it, a new
 *      in-flight version is appended. Prep can exit null when the claim was
 *      cancelled mid-flight or the anchor frame vanished.
 *   2. generate-image / deduct-credits / upload-image — unchanged.
 *   3. persist-result — status-guarded complete (`completeIfLive`), emits
 *      `image.generated`, then SELECT-OR-NOT: a new selection is a pointer
 *      repoint (`frameVariants.select`), never an overwrite. `variantOnly`
 *      (adding a model) appends without selecting; mid-flight input drift
 *      retains a stale-flagged version without repointing the primary.
 */

import { computeVisualPromptInputHash } from '@/lib/ai/input-hash';
import { DEFAULT_IMAGE_MODEL, IMAGE_MODELS } from '@/lib/ai/models';
import { loadNarrowShotPromptContext } from '@/lib/ai/prompt-context';
import { ZERO_MICROS } from '@/lib/billing/money';
import {
  deductWorkflowCredits,
  recordFalUsageStep,
} from '@/lib/billing/workflow-deduction';
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
import { computeImageWorkflowHashFromDto } from '@/lib/workflows/image-workflow-snapshot';
import { shouldRecordUserEdit } from '@/lib/workflows/user-edit-predicate';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'image']);

type ImageWorkflowResult = {
  imageUrl: string;
  shotId?: string;
  sequenceId?: string;
  /**
   * The render's claim was cancelled by the user (before or during the
   * render) and its result was discarded (#1085). Parents must treat this as
   * a stand-down, not a success (nothing landed) and not a failure (the user
   * asked for it).
   */
  cancelled?: boolean;
};

/** Output of `set-generating-status`: the generation params plus the id of the
 * in-flight `frame_variants` version claimed or appended (empty when there's
 * no frame context, e.g. preview mode or a shotless ad-hoc generation). */
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

        // Re-read after any prompt write so we stamp the prompt version that
        // is actually selected for this gen (#1070). Selecting this still later
        // restores that prompt so still + text stay paired.
        const frameForStamp = await scopedDb.frames.getById(frame.id);
        const promptVersionId =
          frameForStamp?.selectedImagePromptVersionId ??
          frame.selectedImagePromptVersionId ??
          null;
        let version;
        if (input.targetVariantId) {
          // #1085: a pre-created claim row exists — transition IT rather than
          // appending. Null = the claim was cancelled before the render
          // started; abandon the run without spending credits.
          version = await scopedDb.frameVariants.claimForGeneration(
            input.targetVariantId,
            {
              workflowRunId,
              model,
              promptVersionId,
              // Direct-regen claims already carry the hash from enqueue;
              // chained claims get it stamped here (the render's snapshot
              // hash), so "updating" detection survives the upstream prompt
              // completing.
              pendingInputHash: input.snapshotInputHash ?? null,
            }
          );
          if (!version) {
            logger.info(
              `[ImageWorkflow] claim ${input.targetVariantId} was cancelled before generation; skipping`
            );
            return null;
          }
        } else {
          version = await scopedDb.frameVariants.appendVersion({
            frameId: frame.id,
            sequenceId: input.sequenceId,
            kind: 'model',
            model,
            status: 'generating',
            workflowRunId,
            promptVersionId,
          });
        }

        // Flip the primary frame to 'generating' only AFTER the claim held
        // (#1095 review): flipping first meant a pre-render cancel abandoned
        // the run with the frame stuck 'generating' forever. Variant-only
        // (adding a model) never flips the primary — only this model's new
        // version carries the in-flight state, so the picker can't trip
        // staleness on the live selection.
        if (!input.variantOnly) {
          await scopedDb.frames.setImageGenerationStatus(
            frame.id,
            // No `imageModel` — the in-flight model is recorded on the
            // version row this step just appended (#1067); the frame only
            // tracks that a primary render is running.
            {
              imageStatus: 'generating',
              imageWorkflowRunId: workflowRunId,
            },
            { throwOnMissing: false }
          );
          // Primary regen claims auto-promote; last kickoff wins (#1070).
          // variantOnly add-model never claims the primary.
          await scopedDb.frames.setPendingPromoteVersionId(
            frame.id,
            version.id
          );
        }

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
      // null prep = claim cancelled / unique-hash stand-down, OR anchor frame
      // gone mid-run. Both are stand-downs for parents today (no imageUrl,
      // cancelled: true) so Update all does not treat a missing frame as a
      // hard stage failure.
      return {
        imageUrl: '',
        shotId: input.shotId,
        sequenceId: input.sequenceId,
        cancelled: true,
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
      return generateImageWithProvider(prep.params, {
        scopedDb,
        observability: {
          observationName: 'shot-image',
          tags: ['image'],
          userId: input.userId,
          sessionId: input.sequenceId,
          metadata: { shotId: input.shotId, model: prep.params.model },
        },
      });
    });

    const imageCostMicros = imageResult.metadata.cost ?? ZERO_MICROS;
    const { teamId, shotId, sequenceId } = input;
    // Before the deduction guard — see recordFalUsageStep (#1069).
    const falUsage = await recordFalUsageStep(
      step,
      scopedDb,
      imageResult.metadata
    );

    if (imageCostMicros > 0 && teamId && !imageResult.metadata.usedOwnKey) {
      await step.do('deduct-credits', async () => {
        await deductWorkflowCredits({
          scopedDb,
          costMicros: imageCostMicros,
          usedOwnKey: imageResult.metadata.usedOwnKey,
          description: `Image generation (${prep.params.model})`,
          idempotencyKey: `${event.instanceId}:image`,
          metadata: {
            ...falUsage,
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

      const writeResult = await step.do(
        'persist-result',
        async (): Promise<{ imageUrl: string; cancelled?: boolean }> => {
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

          // Complete the in-flight version — status-guarded, so a user cancel
          // that raced the render wins: the completed image must not resurrect
          // a cancelled claim row or repoint the selection (#1085). Its
          // inputHash IS the snapshot hash — staleness of this version is its
          // own concern (immutable once done).
          const completed = await scopedDb.frameVariants.completeIfLive(
            versionId,
            {
              url: upload.url,
              storagePath: upload.path,
              previewUrl: null,
              generatedAt: new Date(),
              error: null,
              promptHash,
              inputHash: snapshotHash,
            }
          );
          if (!completed) {
            logger.info(
              `[ImageWorkflow] version ${versionId} went terminal mid-render (user cancel); discarding result`
            );
            // Settle the primary frame the prep step flipped to 'generating' —
            // without this the shot keeps a perpetual spinner (#1095 review).
            if (!input.variantOnly) {
              const frameNow = await scopedDb.frames.getById(frame.id);
              await scopedDb.frames.setImageGenerationStatus(
                frame.id,
                {
                  imageStatus: frameNow?.selectedImageVersionId
                    ? 'completed'
                    : 'pending',
                  imageWorkflowRunId: null,
                  imageError: null,
                },
                { throwOnMissing: false }
              );
              await scopedDb.frames.clearPendingPromoteVersionIdIf(
                frame.id,
                versionId
              );
            }
            return { imageUrl: upload.url, cancelled: true };
          }

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

          // Re-read pending claim: last kickoff / explicit history select may have
          // moved it since this run started (#1070).
          const frameNow = await scopedDb.frames.getById(frame.id);
          const shouldPromote = frameNow?.pendingPromoteVersionId === versionId;

          if (shouldPromote) {
            // Promote even if the prompt/refs drifted mid-flight — the still is
            // stamped with its own inputHash and will surface as stale if the
            // live prompt moved. Explicit selection is what cancels promote.
            await scopedDb.frameVariants.select(frame.id, versionId, {
              actorId: input.userId,
            });
            // A new still invalidates the shot's downstream video.
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
          }

          // Not the promote target — finalize into history only. Reset in-flight
          // frame status so we don't leave a perpetual generating spinner.
          const settleStatus = frameNow?.selectedImageVersionId
            ? 'completed'
            : 'pending';
          await scopedDb.frames.setImageGenerationStatus(
            frame.id,
            {
              imageStatus: settleStatus,
              imageWorkflowRunId: null,
              imageError: null,
            },
            { throwOnMissing: false }
          );
          // Clear pending only if it still points at us (shouldn't if user
          // cancelled; belt-and-suspenders if claim was stale).
          await scopedDb.frames.clearPendingPromoteVersionIdIf(
            frame.id,
            versionId
          );
          await channel.emit('generation.image:progress', {
            shotId,
            status: settleStatus,
            model,
          });
          logger.info(
            `[ImageWorkflow] Uploaded unselected (pending promote moved): ${upload.path}`
          );
          return { imageUrl: upload.url };
        }
      );
      imageUrl = writeResult.imageUrl;
      if (writeResult.cancelled) {
        return { imageUrl, shotId, sequenceId, cancelled: true };
      }
    } else if (imageUrl && shotId && input.skipStorage) {
      await step.do('store-preview-url', async () => {
        const anchor = await scopedDb.frames.getAnchorByShot(shotId);
        const updatedFrame = anchor
          ? await scopedDb.frames.setImageGenerationStatus(
              anchor.id,
              { previewImageUrl: imageUrl, imageError: null },
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
        // Drop auto-promote if this run owned it (#1070).
        if (anchor.pendingPromoteVersionId) {
          const pending = await scopedDb.frameVariants.getById(
            anchor.pendingPromoteVersionId
          );
          if (pending?.workflowRunId === event.instanceId) {
            await scopedDb.frames.clearPendingPromoteVersionIdIf(
              anchor.id,
              pending.id
            );
          }
        }
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
