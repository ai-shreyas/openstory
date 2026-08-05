/**
 * Motion Server Functions
 * Shot motion (image-to-video) generation operations.
 */

import { createServerFn } from '@tanstack/react-start';
import {
  loadSceneContextBySequence,
  resolveSceneForShot,
} from '@/lib/scenes/scene-script';
import type { Shot } from '@/lib/db/schema';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

import { AUDIO_MODELS } from '@/lib/ai/models';
import { resolveVideoModel } from '@/lib/ai/resolve-asset-models';
import { getEffectiveFalPricing } from '@/lib/ai/fal-pricing-live';
import { estimateVideoCost, gateEstimate } from '@/lib/billing/cost-estimation';
import {
  estimateBatchMotionCost,
  resolveBatchShotVideoModel,
} from '@/lib/motion/batch-motion-cost';
import { requireCredits } from '@/lib/billing/preflight';
import { buildMotionReferenceImages } from '@/lib/motion/build-motion-references';
import { resolveShotDuration } from '@/lib/motion/resolve-shot-duration';
import { generateMotionSchema } from '@/lib/schemas/shot.schemas';
import { dbSceneId } from '@/lib/db/schema';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import type { BatchMotionMusicWorkflowInput } from '@/lib/workflow/types';

import { resolveMotionPromptFromVersion } from '@/lib/motion/resolve-motion-prompt';
import { getFrameImageUrl } from '@/lib/shots/frame-image';
import { projectShotWithImage } from '@/lib/shots/shot-with-image';
import { rescanContinuityFromPrompt } from '@/lib/scenes/rescan-continuity-from-prompt';

import { shotAccessMiddleware, sequenceAccessMiddleware } from './middleware';

// -- Generate Motion for Shot -------------------------------------------

const generateMotionInputSchema = generateMotionSchema.extend({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
});

export const generateShotMotionFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .inputValidator(zodValidator(generateMotionInputSchema))
  .handler(async ({ data, context }) => {
    const { shot, frame, sequence, teamId } = context;

    // The still lives on the anchor frame's SELECTED version (#989/#1067).
    // Capture into a const so the non-null narrowing survives the awaits
    // before the workflow input.
    const imageUrl = await getFrameImageUrl(context.scopedDb, frame.id);
    if (!imageUrl) {
      throw new Error('Shot has no thumbnail to generate motion from');
    }

    // Model identity lives on the version that rendered the clip (#1066):
    // explicit request model wins, else the version the shot's render segment
    // currently points at, then the sequence default.
    const [selectedVersion, lastFailed] = await Promise.all([
      context.scopedDb.videoVariants.getSelectedByShot(shot.id),
      context.scopedDb.videoVariants.getLastFailedByShot(shot.id),
    ]);
    const model = resolveVideoModel({
      explicit: data.model,
      lastFailedAttemptModel: lastFailed?.model,
      selectedVersionModel: selectedVersion?.model,
      sequenceModel: sequence.videoModel,
    });

    const userEditedPrompt = Boolean(data.prompt);
    const selectedMotion =
      await context.scopedDb.shotPromptVersions.getSelectedMotion(shot.id);
    const prompt =
      data.prompt ||
      resolveMotionPromptFromVersion(
        selectedMotion,
        {
          characterTags: context.scene?.continuity?.characterTags,
          description: context.scene?.originalScript.extract ?? null,
        },
        model
      );

    // Auto-link any element/cast/location tags the user mentioned in their
    // edited motion prompt into the scene's continuity, so downstream
    // consumers (next image regenerate, shot-image reference attachment, and
    // the motion reference attachment below) see the new references.
    let effectiveContinuity = context.scene?.continuity;
    if (userEditedPrompt && effectiveContinuity) {
      const rescan = await rescanContinuityFromPrompt({
        scopedDb: context.scopedDb,
        sequenceId: sequence.id,
        existing: effectiveContinuity,
        promptText: prompt,
      });
      if (rescan.changed && shot.sceneId) {
        effectiveContinuity = rescan.continuity;
        await context.scopedDb.scenes.update(
          dbSceneId(shot.sceneId),
          { continuity: rescan.continuity },
          { throwOnMissing: false }
        );
      }
    }

    // Resolve cast/element reference images so motion preserves identity across
    // the clip, not just in the start frame (#873). Only Kling v3 Pro emits
    // them downstream; threaded for every model so they're ready if support
    // widens. Matches the continuity AFTER any rescan above.
    const [characters, elements] = await Promise.all([
      context.scopedDb.characters.listWithSheets(sequence.id),
      context.scopedDb.sequenceElements.list(sequence.id),
    ]);
    const referenceImages = buildMotionReferenceImages({
      scene: context.scene
        ? { ...context.scene, continuity: effectiveContinuity }
        : null,
      characters,
      elements,
    });

    // Snap the resolved duration onto the selected model's valid set before
    // both the credit pre-flight and the workflow input — otherwise an
    // unsnapped value (e.g. legacy `durationMs` from a different model) gets
    // priced at the raw seconds while the workflow bills against the snapped
    // value, leaving the two paths inconsistent.
    const duration = resolveShotDuration({
      explicit: data.duration,
      durationMs: shot.durationMs,
      model,
    });

    await requireCredits(
      context.scopedDb,
      gateEstimate(
        estimateVideoCost(model, duration, {
          pricing: await getEffectiveFalPricing(),
        }),
        { model, operation: 'motion' }
      ),
      { errorMessage: 'Insufficient credits for motion generation' }
    );

    const workflowInput: BatchMotionMusicWorkflowInput = {
      userId: context.user.id,
      teamId,
      sequenceId: sequence.id,
      includeMusic: false,
      shots: [
        {
          shotId: shot.id,
          imageUrl,
          prompt,
          model,
          duration,
          fps: data.fps,
          motionBucket: data.motionBucket,
          aspectRatio: sequence.aspectRatio,
          generateAudio: data.generateAudio,
          userEditedPrompt,
          // Capture the edited version's dialogue/audio now so the workflow can
          // carry it onto the recorded user-edit version without a racy /
          // replay-unsafe in-workflow DB re-read (#713/#991).
          priorMotion: userEditedPrompt
            ? {
                dialogue: selectedMotion?.dialogue ?? null,
                audio: selectedMotion?.audio ?? null,
              }
            : undefined,
          referenceImages,
        },
      ],
    };

    const workflowRunId = await triggerWorkflow(
      '/motion-batch',
      workflowInput,
      {
        deduplicationId: `motion-batch-${shot.id}-${Date.now()}`,
        label: buildWorkflowLabel(sequence.id),
      }
    );

    return { workflowRunId, shotId: shot.id };
  });

// -- Batch Generate Motion for Sequence ----------------------------------

const batchGenerateMotionInputSchema = z.object({
  sequenceId: ulidSchema,
  includeMusic: z.boolean().optional(),
  model: generateMotionSchema.shape.model,
  musicModel: z
    .enum(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Required for z.enum with dynamic keys
      Object.keys(AUDIO_MODELS) as [keyof typeof AUDIO_MODELS]
    )
    .optional(),
  duration: generateMotionSchema.shape.duration,
  fps: generateMotionSchema.shape.fps,
  motionBucket: generateMotionSchema.shape.motionBucket,
  generateAudio: generateMotionSchema.shape.generateAudio,
});

export const batchGenerateMotionFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(zodValidator(batchGenerateMotionInputSchema))
  .handler(async ({ data, context }) => {
    const { sequence, teamId, user } = context;

    // Project the anchor-frame image surface (#989) so the eligibility filter
    // and downstream `shot.thumbnailUrl` reads keep working unchanged.
    const rawShots = await context.scopedDb.shots.listBySequence(sequence.id);
    const anchorsByShot = new Map(
      (await context.scopedDb.frames.listAnchorsBySequence(sequence.id)).map(
        (f) => [f.shotId, f]
      )
    );
    const sceneContext = await loadSceneContextBySequence(
      context.scopedDb,
      sequence.id
    );
    const sceneOf = (s: Pick<Shot, 'sceneId' | 'durationMs'>) =>
      resolveSceneForShot(s, sceneContext).scene;
    const [
      selectedByFrame,
      selectedPromptByFrame,
      selectedVideoByShot,
      primaryVideoByShot,
    ] = await Promise.all([
      context.scopedDb.frameVariants.getSelectedByFrameIds(
        [...anchorsByShot.values()].map((f) => f.id)
      ),
      context.scopedDb.framePromptVersions.getSelectedByFrameIds(
        [...anchorsByShot.values()].map((f) => f.id)
      ),
      context.scopedDb.videoVariants.getSelectedByShotIds(
        rawShots.map((s) => s.id)
      ),
      context.scopedDb.videoVariants.getPrimaryByShotIds(
        rawShots.map((s) => s.id)
      ),
    ]);
    const allShots = rawShots.flatMap((s) => {
      const frame = anchorsByShot.get(s.id);
      return frame
        ? [
            projectShotWithImage(s, frame, {
              selectedImage: selectedByFrame.get(frame.id) ?? null,
              selectedImagePrompt: selectedPromptByFrame.get(frame.id) ?? null,
              selectedVideo: selectedVideoByShot.get(s.id) ?? null,
              primaryVideo: primaryVideoByShot.get(s.id) ?? null,
            }),
          ]
        : [];
    });
    // Server determines eligible shots: still done, video pending/failed
    const eligibleShots = allShots.filter(
      (f) =>
        f.thumbnailStatus === 'completed' &&
        f.thumbnailUrl &&
        (f.videoStatus === 'pending' || f.videoStatus === 'failed')
    );

    if (eligibleShots.length === 0) {
      throw new Error('No eligible shots for motion generation');
    }

    // Model identity lives on the version that rendered each clip (#1066).
    // Resolve each shot's model from its selected video version (an explicit
    // batch `data.model` still overrides everything). One join, no N+1.
    const [selected, lastFailed] = await Promise.all([
      context.scopedDb.videoVariants.listSelectedModelsBySequence(sequence.id),
      context.scopedDb.videoVariants.listLastFailedModelsBySequence(
        sequence.id
      ),
    ]);
    const shotModels = { selected, lastFailed };
    const resolveShotVideoModel = (shot: (typeof allShots)[number]) =>
      resolveBatchShotVideoModel(shot, shotModels, sequence, data.model);

    // Sum per-shot costs — shots may render with different (priced) models.
    const estimatedCost = estimateBatchMotionCost(
      eligibleShots,
      shotModels,
      sequence,
      {
        explicitModel: data.model,
        duration: data.duration,
        pricing: await getEffectiveFalPricing(),
      }
    );

    await requireCredits(context.scopedDb, estimatedCost, {
      errorMessage: `Insufficient credits for batch motion generation (${eligibleShots.length} shots)`,
    });

    const includeMusic =
      (data.includeMusic ?? false) && sequence.musicStatus !== 'generating';

    // Persist the batch model picks so the sequence header chip, future batch
    // sessions, and storyboard regen reflect what the user just chose.
    const videoModelChanged = data.model && data.model !== sequence.videoModel;
    const musicModelChanged =
      includeMusic &&
      data.musicModel &&
      data.musicModel !== sequence.musicModel;
    if (videoModelChanged || musicModelChanged) {
      await context.scopedDb.sequences.update({
        id: sequence.id,
        ...(videoModelChanged ? { videoModel: data.model } : {}),
        ...(musicModelChanged ? { musicModel: data.musicModel } : {}),
      });
    }

    // Resolve cast/element reference images once for the whole batch (#873) —
    // matched per frame below against each frame's continuity tags.
    const [characters, elements] = await Promise.all([
      context.scopedDb.characters.listWithSheets(sequence.id),
      context.scopedDb.sequenceElements.list(sequence.id),
    ]);

    // Build music config if requested
    let musicConfig: BatchMotionMusicWorkflowInput['music'];
    if (includeMusic) {
      if (!sequence.musicPrompt || !sequence.musicTags) {
        throw new Error('No music prompt or tags found');
      }

      const totalDuration = allShots.reduce(
        (sum, shot) => sum + (shot.durationMs ? shot.durationMs / 1000 : 10),
        0
      );

      musicConfig = {
        prompt: sequence.musicPrompt,
        tags: sequence.musicTags,
        duration: totalDuration || 30,
        model: data.musicModel,
      };
    }

    // Batch-load the selected motion prompt version for every eligible shot —
    // the resolution source of truth (#713), replacing `metadata.prompts.motion`.
    const selectedMotionByShot =
      await context.scopedDb.shotPromptVersions.getSelectedMotionByShots(
        eligibleShots.map((s) => s.id)
      );

    const workflowInput: BatchMotionMusicWorkflowInput = {
      userId: user.id,
      teamId,
      sequenceId: sequence.id,
      includeMusic,
      shots: eligibleShots.map((shot) => {
        const shotModel = resolveShotVideoModel(shot);
        const scene = sceneOf(shot);
        return {
          shotId: shot.id,
          imageUrl: shot.thumbnailUrl ?? '',
          prompt: resolveMotionPromptFromVersion(
            selectedMotionByShot.get(shot.id),
            {
              characterTags: scene?.continuity?.characterTags,
              description: scene?.originalScript.extract ?? null,
            },
            shotModel
          ),
          model: shotModel,
          duration:
            data.duration ?? (shot.durationMs ? shot.durationMs / 1000 : 3),
          fps: data.fps,
          motionBucket: data.motionBucket,
          aspectRatio: sequence.aspectRatio,
          generateAudio: data.generateAudio,
          referenceImages: buildMotionReferenceImages({
            scene,
            characters,
            elements,
          }),
        };
      }),
      music: musicConfig,
    };

    const workflowRunId = await triggerWorkflow(
      '/motion-batch',
      workflowInput,
      {
        deduplicationId: `motion-batch-${sequence.id}-${Date.now()}`,
        label: buildWorkflowLabel(sequence.id),
      }
    );

    return {
      sequenceId: sequence.id,
      totalShots: allShots.length,
      eligibleShots: eligibleShots.length,
      workflowRunId,
      includeMusic,
    };
  });
