/**
 * Upscale a chosen 3×3 grid tile into the frame's primary still (#989).
 *
 * The picked tile is cropped (a Cloudflare Image Resizing URL) by
 * `selectShotVariantFn`, then this workflow upscales it and records the result
 * as a `kind:'framing'` `frame_variants` version (`sourceVariantId` = the grid
 * sheet it came from) and SELECTS it — a pointer repoint that mirrors the new
 * still onto the frame, never an overwrite. Downstream video (still on `shots`
 * until Phase 3) is reset because the anchor still changed.
 */

import { IMAGE_MODELS } from '@/lib/ai/models';
import { resolveUpscaleModel } from '@/lib/ai/resolve-asset-models';
import { ZERO_MICROS } from '@/lib/billing/money';
import {
  deductWorkflowCredits,
  recordFalUsageStep,
} from '@/lib/billing/workflow-deduction';
import {
  aspectRatioToImageSize,
  DEFAULT_IMAGE_SIZE,
} from '@/lib/constants/aspect-ratios';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import type { NewFrameVariant, NewShot } from '@/lib/db/schema';
import { generateImageWithProvider } from '@/lib/image/image-generation';
import { uploadImageToStorage } from '@/lib/image/image-storage';
import { buildReferenceImagePrompt } from '@/lib/prompts/reference-image-prompt';
import { getGenerationChannel } from '@/lib/realtime';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type {
  UpscaleShotVariantWorkflowInput,
  UpscaleShotVariantWorkflowResult,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getAnchorImageUrl } from '@/lib/shots/frame-image';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'upscale-shot-variant']);

const UPSCALE_PROMPT = `Upscale this image to a clean, high-resolution shot suitable for animation.

RENDERING RULES
- Keep the original scene, pose, framing and camera angle IDENTICAL.
- Preserve the identity of all real people:
  - Do NOT change their faces, expressions, hairstyles, or clothing.
  - Do NOT add new people or remove existing people.
- Faces:
  - Make faces sharp and detailed.
  - Clear eyes, natural skin texture, no plastic or over-smoothed look.
- Text & logos:
  - Preserve all printed text, signage, and logos exactly as they appear.
  - Re-render text cleanly at higher resolution.
  - Do NOT invent new words, change names, or move signs.
- Style:
  - Realistic photographic look.
  - Keep original colours, lighting and depth of field.
  - No extra filters, bokeh, vignettes, film grain, or stylistic changes unless they already exist.

OUTPUT
- A SINGLE high-resolution image.
- Aspect ratio: match the original exactly.
- Resolution: upscale to animation-ready quality.
- No text overlays, borders, watermarks, or new graphics added by the model.`;

/** The frame/variant/shot writes `persistUpscaleSelection` needs — a narrow
 * slice of {@link ScopedDb} so unit tests can inject a small spy. */
export type PersistUpscaleScopedDb = {
  frameVariants: {
    update: (
      versionId: string,
      data: Partial<NewFrameVariant>
    ) => Promise<{ id: string }>;
    select: (
      frameId: string,
      versionId: string,
      opts: { actorId: string | null }
    ) => Promise<{ id: string }>;
  };
  liveRead: {
    frames: {
      // Existence only — the frame is the trigger's, never re-resolved here.
      getById: (frameId: string) => Promise<{ id: string } | null>;
    };
  };
  shots: {
    update: (
      shotId: string,
      data: Partial<NewShot>,
      options?: { throwOnMissing?: boolean }
    ) => Promise<{ id: string } | undefined>;
  };
};

type UpscaleImageProgress = {
  shotId: string;
  status: 'completed';
  thumbnailUrl: string;
};

/**
 * Complete the in-flight upscaled framing version and REPOINT the frame's
 * primary still at it (pointer + mirror, via `frameVariants.select`). Extracted
 * from the workflow's `select-upscaled-version` step so the repoint outcome is
 * unit-testable without the fal/storage/credit steps. The frame is the trigger's
 * (frame id ≠ shot id, #989) — resolving the anchor here would let a mid-run
 * anchor change move the still onto a different frame than the run claimed. It
 * is checked for existence only; `{ selected: false }` (a no-op past the version
 * completion) means it was deleted mid-flight.
 */
export async function persistUpscaleSelection(params: {
  scopedDb: PersistUpscaleScopedDb;
  shotId: string;
  frameId: string;
  versionId: string;
  url: string;
  path: string | null;
  actorId: string;
  generatedAt: Date;
  emit: (payload: UpscaleImageProgress) => Promise<void>;
}): Promise<{ selected: boolean }> {
  const {
    scopedDb,
    shotId,
    frameId,
    versionId,
    url,
    path,
    actorId,
    generatedAt,
    emit,
  } = params;

  await scopedDb.frameVariants.update(versionId, {
    status: 'completed',
    url,
    storagePath: path,
    generatedAt,
    error: null,
  });

  const frame = await scopedDb.liveRead.frames.getById(frameId);
  if (!frame) {
    logger.info(
      `[UpscaleShotVariantWorkflow] Frame ${frameId} vanished, skipping select`
    );
    return { selected: false };
  }

  await scopedDb.frameVariants.select(frameId, versionId, { actorId });

  await emit({ shotId, status: 'completed', thumbnailUrl: url });
  return { selected: true };
}

export class UpscaleShotVariantWorkflow extends OpenStoryWorkflowEntrypoint<UpscaleShotVariantWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<UpscaleShotVariantWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<UpscaleShotVariantWorkflowResult> {
    const input = event.payload;
    const workflowRunId = event.instanceId;

    const { sequenceId, teamId, shotId, userId } = input;
    if (!sequenceId || !teamId || !shotId) {
      throw new WorkflowValidationError('sequenceId and teamId are required');
    }

    // Derived from the payload, so it survives a step replay unchanged.
    const upscaleModel = resolveUpscaleModel(input.sourceModel);

    logger.info(
      `[UpscaleShotVariantWorkflow] Starting upscale for shot ${shotId} with model ${upscaleModel}`
    );

    const upscaleResult = await step.do('upscale-image', async () => {
      await getGenerationChannel(sequenceId).emit('generation.image:progress', {
        shotId,
        status: 'generating',
      });

      // The frame is the trigger's (payload `frameId`) — checked for existence,
      // never re-resolved, so both this step and the select step write to the
      // same frame.
      const frame = await scopedDb.liveRead.frames.getById(input.frameId);
      if (!frame) {
        logger.info(
          `[UpscaleShotVariantWorkflow] Frame ${input.frameId} (shot ${shotId}) is gone, skipping`
        );
        return null;
      }

      // Record the in-flight framing version (the upscaled tile), pointing back
      // at the grid sheet it was cropped from. `model` is the model that
      // actually renders the upscale — this version becomes the frame's
      // selection, so it is also what the shot resolves its model from (#1066).
      // `promptVersionId` is the trigger's snapshot: this version becomes the
      // selection, so without it a prompt-restore from this still no-ops.
      const version = await scopedDb.frameVariants.appendVersion({
        frameId: frame.id,
        sequenceId,
        kind: 'framing',
        model: upscaleModel,
        sourceVariantId: input.sourceVariantId ?? null,
        promptVersionId: input.promptVersionId,
        status: 'generating',
        workflowRunId,
      });

      // The cropped tile rides through the builder as the primary reference so
      // the prompt's Image numbering matches the image_urls array — prepending
      // it afterwards would shift every legend/inline binding off by one.
      const allReferences = [
        {
          referenceImageUrl: input.croppedTileUrl,
          description: 'The source shot to upscale — the output is this image',
          role: 'primary' as const,
        },
        ...(input.characterReferences ?? []).map((r) => ({
          ...r,
          role: r.role ?? ('character' as const),
        })),
        ...(input.locationReferences ?? []).map((r) => ({
          ...r,
          role: r.role ?? ('location' as const),
        })),
      ];
      const { prompt: enhancedPrompt, referenceUrls } =
        buildReferenceImagePrompt(
          UPSCALE_PROMPT,
          allReferences,
          IMAGE_MODELS[upscaleModel].maxPromptLength
        );

      const imageSize = input.aspectRatio
        ? aspectRatioToImageSize(input.aspectRatio)
        : DEFAULT_IMAGE_SIZE;

      const result = await generateImageWithProvider(
        {
          model: upscaleModel,
          prompt: enhancedPrompt,
          imageSize,
          referenceImageUrls: referenceUrls,
          numImages: 1,
          outputFormat: 'png',
        },
        { scopedDb: scopedDb.credentials }
      );
      return {
        imageUrl: result.imageUrls[0],
        cost: result.metadata.cost ?? ZERO_MICROS,
        usedOwnKey: result.metadata.usedOwnKey,
        endpointId: result.metadata.endpointId,
        unitsBilled: result.metadata.unitsBilled,
        versionId: version.id,
      };
    });

    if (!upscaleResult) {
      return { upscaledUrl: '', upscaledPath: '' };
    }

    // Before the deduction guard — see recordFalUsageStep (#1069).
    const falUsage = await recordFalUsageStep(step, scopedDb, upscaleResult);

    await step.do('deduct-credits', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: upscaleResult.cost,
        usedOwnKey: upscaleResult.usedOwnKey,
        description: `Variant upscale (${upscaleModel})`,
        idempotencyKey: `${event.instanceId}:upscale`,
        metadata: {
          ...falUsage,
          shotId,
          sequenceId,
          model: upscaleModel,
        },
        workflowName: 'UpscaleShotVariantWorkflow',
      });
    });

    const storageResult = await step.do('upload-to-storage', async () => {
      if (!upscaleResult.imageUrl) {
        throw new Error('Upscale did not return an image URL');
      }
      const result = await uploadImageToStorage({
        imageUrl: upscaleResult.imageUrl,
        teamId,
        sequenceId,
        shotId,
      });
      if (!result.url) {
        throw new Error('Failed to upload upscaled image to storage');
      }
      return { url: result.url, path: result.path };
    });

    await step.do('select-upscaled-version', async () => {
      // Completes the version + repoints the frame's still + resets video.
      const { selected } = await persistUpscaleSelection({
        scopedDb,
        shotId,
        frameId: input.frameId,
        versionId: upscaleResult.versionId,
        url: storageResult.url,
        path: storageResult.path || null,
        actorId: userId,
        generatedAt: new Date(),
        emit: (payload) =>
          getGenerationChannel(sequenceId).emit(
            'generation.image:progress',
            payload
          ),
      });

      if (selected) {
        logger.info(
          `[UpscaleShotVariantWorkflow] Upscale completed + selected for shot ${shotId}`
        );
      }
    });

    return {
      upscaledUrl: storageResult.url,
      upscaledPath: storageResult.path || '',
    } satisfies UpscaleShotVariantWorkflowResult;
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<UpscaleShotVariantWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): Promise<void> {
    const input = event.payload;
    logger.error(
      `[UpscaleShotVariantWorkflow] Upscale failed for shot ${input.shotId}: ${error}`
    );
    if (!input.shotId || !input.teamId) return;

    // Mark the in-flight framing version failed; the frame's PRIOR selection is
    // untouched, so revert the UI to the real selected still rather than showing
    // a false failure on a good image.
    await scopedDb.frameVariants.markFailedByWorkflowRun(
      event.instanceId,
      error
    );
    if (input.sequenceId) {
      // The upscale just became the frame's selection; read the still back
      // off that version rather than a frame column (#1067).
      const thumbnailUrl = await getAnchorImageUrl(
        scopedDb.liveRead,
        input.shotId
      );
      await getGenerationChannel(input.sequenceId).emit(
        'generation.image:progress',
        {
          shotId: input.shotId,
          status: 'completed',
          ...(thumbnailUrl ? { thumbnailUrl } : {}),
        }
      );
    }
  }
}
