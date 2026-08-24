/**
 * Smart-retry orchestration (#1257: moved out of `functions/smart-retry.ts`).
 * Detects what failed in a sequence and only retries those parts.
 * Falls back to full storyboard retry when prompts are missing.
 *
 * Lives outside `src/functions/` because the Start compiler keeps a server fn
 * file's exported helpers in the CLIENT bundle — as a `functions/` export this
 * dragged fal-pricing-live (→ #db-client → drizzle) and the workflow client
 * into every dev page load. The serverFn handler references it only inside its
 * body, which the compiler strips.
 */

import {
  loadSceneContextBySequence,
  resolveSceneForShot,
} from '@/lib/scenes/scene-script';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MUSIC_MODEL,
  DEFAULT_VIDEO_MODEL,
  safeAudioModel,
  safeImageToVideoModel,
  safeTextToImageModel,
} from '@/lib/ai/models';
import {
  DEFAULT_ANALYSIS_MODEL,
  getAnalysisModelById,
} from '@/lib/ai/models.config';
import {
  resolveImageModel,
  resolveVideoModel,
} from '@/lib/ai/resolve-asset-models';
import {
  estimateImageCost,
  estimateVideoCost,
  gateEstimate,
} from '@/lib/billing/cost-estimation';
import { getEffectiveFalPricing } from '@/lib/ai/fal-pricing-live';
import { addMicros, ZERO_MICROS } from '@/lib/billing/money';
import { requireCredits } from '@/lib/billing/preflight';
import { estimateStoryboardPreflightCost } from '@/lib/billing/storyboard-preflight-cost';
import { aspectRatioToImageSize } from '@/lib/constants/aspect-ratios';
import type { ScopedDb } from '@/lib/db/scoped';
import { type Character, type Sequence, type Shot } from '@/lib/db/schema';
import { analyzeFailures } from '@/lib/failures/failure-analysis';
import {
  motionPromptFromVersion,
  resolveMotionPromptFromVersion,
} from '@/lib/motion/resolve-motion-prompt';
import { toShotView } from '@/lib/shots/shot-view';
import { buildCharacterReferenceImages } from '@/lib/prompts/character-prompt';
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import {
  assertNoActiveStoryboard,
  triggerStoryboard,
} from '@/lib/workflow/launchers';
import type {
  ImageWorkflowInput,
  MotionWorkflowInput,
  MusicPromptWorkflowInput,
  MusicWorkflowInput,
} from '@/lib/workflow/types';
import { buildMusicSceneSummaries } from '@/lib/workflows/music-scene-summaries';
import { sumShotDurationsSeconds } from '@/lib/sequences/shot-durations';

function getSceneCharacterReferenceImages(
  allCharacters: Character[],
  characterTags: string[]
) {
  if (characterTags.length === 0) return [];

  const matchedCharacters = allCharacters.filter((char) => {
    const consistencyTag = (char.consistencyTag ?? '').toLowerCase();
    const charName = char.name.toLowerCase();

    return characterTags.some((tag) => {
      const tagLower = tag.toLowerCase();
      return (
        (consistencyTag && tagLower.includes(consistencyTag)) ||
        tagLower.includes(charName) ||
        tagLower.includes(char.characterId.toLowerCase())
      );
    });
  });

  return buildCharacterReferenceImages(matchedCharacters);
}

/** The slice of the middleware context `executeSmartRetry` needs. */
export type SmartRetryContext = {
  sequence: Sequence;
  user: { id: string };
  teamId: string;
  scopedDb: ScopedDb;
};

/**
 * Handler body, extracted so unit tests can exercise the orchestration
 * (mutex gate → retry planning → triggers → status reset) without the
 * server-fn middleware chain.
 */
export async function executeSmartRetry(context: SmartRetryContext) {
  const { sequence, user, teamId } = context;

  // A sequence marked failed does NOT imply its workflow tree is dead —
  // children outlive a timed-out parent (#839). Reject every retry shape
  // (full and partial) while the last storyboard run is still in flight,
  // so we never race a live pipeline.
  await assertNoActiveStoryboard(context.scopedDb, sequence.id);

  const shots = await context.scopedDb.shots.listBySequence(sequence.id);
  // The still-image surface lives on each shot's anchor frame now (#989) —
  // resolved keyed by shotId, never by id-reuse.
  await context.scopedDb.shots.ensureAnchorFrames(shots);
  const anchorsByShot = new Map(
    (await context.scopedDb.frames.listAnchorsBySequence(sequence.id)).map(
      (fr) => [fr.shotId, fr]
    )
  );
  const [
    selectedByFrame,
    selectedPromptByFrame,
    selectedVideoByShot,
    primaryVideoByShot,
    selectedMotionByShot,
  ] = await Promise.all([
    context.scopedDb.frameVariants.getSelectedByFrameIds(
      [...anchorsByShot.values()].map((fr) => fr.id)
    ),
    context.scopedDb.framePromptVersions.getSelectedByFrameIds(
      [...anchorsByShot.values()].map((fr) => fr.id)
    ),
    context.scopedDb.videoVariants.getSelectedByShotIds(shots.map((s) => s.id)),
    context.scopedDb.videoVariants.getPrimaryByShotIds(shots.map((s) => s.id)),
    context.scopedDb.shotPromptVersions.getSelectedMotionByShots(
      shots.map((s) => s.id)
    ),
  ]);
  const shotViews = shots.flatMap((shot) => {
    const frame = anchorsByShot.get(shot.id);
    if (!frame) return [];
    const selectedMotion = selectedMotionByShot.get(shot.id);
    return [
      toShotView(shot, frame, {
        image: selectedByFrame.get(frame.id) ?? null,
        // Retry planning only — nothing here renders a thumbnail, so the
        // pre-prompt stand-in (#1101) is not resolved.
        preview: null,
        imagePromptVersion: selectedPromptByFrame.get(frame.id) ?? null,
        video: selectedVideoByShot.get(shot.id) ?? null,
        primaryVideo: primaryVideoByShot.get(shot.id) ?? null,
        motionPrompt: selectedMotion
          ? motionPromptFromVersion(selectedMotion)
          : null,
      }),
    ];
  });
  const sceneContext = await loadSceneContextBySequence(
    context.scopedDb,
    sequence.id
  );
  const sceneOf = (s: Pick<Shot, 'sceneId' | 'durationMs'>) =>
    resolveSceneForShot(s, sceneContext).scene;
  const scenesById = new Map(
    [...sceneContext].map(([sceneId, ctx]) => [sceneId, ctx.scene])
  );
  const summary = analyzeFailures(shotViews, sequence, scenesById);

  if (!summary.hasFailed) {
    throw new Error('No failures found to retry');
  }

  // Full retry fallback
  if (summary.requiresFullRetry) {
    const imageModel = safeTextToImageModel(
      sequence.imageModel,
      DEFAULT_IMAGE_MODEL
    );
    const videoModel = safeImageToVideoModel(
      sequence.videoModel,
      DEFAULT_VIDEO_MODEL
    );

    await requireCredits(
      context.scopedDb,
      estimateStoryboardPreflightCost({
        script: sequence.script ?? '',
        imageModel,
        aspectRatio: sequence.aspectRatio,
        autoGenerateMotion: sequence.autoGenerateMotion,
        videoModels: [videoModel],
        autoGenerateMusic: sequence.autoGenerateMusic,
        audioModels: [safeAudioModel(sequence.musicModel, DEFAULT_MUSIC_MODEL)],
        pricing: await getEffectiveFalPricing(),
      }),
      {
        providers: ['fal', 'openrouter'],
        errorMessage: 'Insufficient credits to retry storyboard',
      }
    );

    // Owns the generation mutex, the 'processing' status write, and the
    // run-id persistence (#839).
    await triggerStoryboard(context.scopedDb, {
      userId: user.id,
      teamId,
      sequenceId: sequence.id,
      options: {
        shotsPerScene: 3,
        generateThumbnails: true,
        generateDescriptions: true,
        aiProvider: 'openrouter',
        regenerateAll: true,
      },
      autoGenerateMotion: sequence.autoGenerateMotion,
      autoGenerateMusic: sequence.autoGenerateMusic,
    });

    return { retryType: 'full' as const, retriedItems: ['full storyboard'] };
  }

  // Smart retry: only retry failed parts
  const retried: string[] = [];
  let totalCost = ZERO_MICROS;

  // Model identity lives on the version that produced each asset (#1066).
  // Every shot here is in a failed state, so the FAILED attempt's model is the
  // one the user actually asked for — it outranks the (older, still selected)
  // successful version, which is what a retry would otherwise silently re-run.
  // Four joins, no N+1.
  const [
    selectedImageModels,
    selectedVideoModels,
    failedImageModels,
    failedVideoModels,
  ] = await Promise.all([
    context.scopedDb.frameVariants.listSelectedModelsBySequence(sequence.id),
    context.scopedDb.videoVariants.listSelectedModelsBySequence(sequence.id),
    context.scopedDb.frameVariants.listLastFailedModelsBySequence(sequence.id),
    context.scopedDb.videoVariants.listLastFailedModelsBySequence(sequence.id),
  ]);
  const imageModelFor = (shot: (typeof shotViews)[number]) =>
    resolveImageModel({
      lastFailedAttemptModel: failedImageModels.get(shot.id),
      selectedVersionModel: selectedImageModels.get(shot.id),
      sequenceModel: sequence.imageModel,
    });
  const videoModelFor = (shot: (typeof shotViews)[number]) =>
    resolveVideoModel({
      lastFailedAttemptModel: failedVideoModels.get(shot.id),
      selectedVersionModel: selectedVideoModels.get(shot.id),
      sequenceModel: sequence.videoModel,
    });

  // Collect failed items and estimate costs
  const failedImageShots = shotViews.filter(
    (f) => f.frame.imageStatus === 'failed'
  );
  const failedMotionShots = shotViews.filter(
    (f) =>
      f.videoStatus === 'failed' && f.image?.url && f.motionPrompt?.fullPrompt
  );
  const hasMusicFailure =
    sequence.musicStatus === 'failed' && sequence.musicPrompt;

  // Calculate total cost — sum per shot since scenes may use different models.
  const pricing = await getEffectiveFalPricing();
  for (const shot of failedImageShots) {
    totalCost = addMicros(
      totalCost,
      gateEstimate(
        estimateImageCost(imageModelFor(shot), sequence.aspectRatio, 1, {
          pricing,
        }),
        { model: imageModelFor(shot), operation: 'smart-retry:image' }
      )
    );
  }

  if (failedMotionShots.length > 0) {
    const { snapDuration } = await import('@/lib/motion/snap-duration');
    for (const shot of failedMotionShots) {
      const model = videoModelFor(shot);
      totalCost = addMicros(
        totalCost,
        gateEstimate(
          estimateVideoCost(model, snapDuration(undefined, model), { pricing }),
          { model, operation: 'smart-retry:motion' }
        )
      );
    }
  }

  // Single credit check for all retries
  if (totalCost > 0) {
    await requireCredits(context.scopedDb, totalCost, {
      providers: ['fal'],
      errorMessage: 'Insufficient credits to retry failed items',
    });
  }

  // 1. Retry failed images
  if (failedImageShots.length > 0) {
    const allCharacters = await context.scopedDb.characters.listWithSheets(
      sequence.id
    );

    // Count what we actually trigger — shots skipped below must not be
    // reported as retried (and must not clear the failed flag on their own).
    let triggeredImages = 0;
    for (const shot of failedImageShots) {
      const scene = sceneOf(shot);
      const promptVersion = shot.imagePromptVersion;
      const prompt = promptVersion?.text || scene?.originalScript.extract;

      if (!prompt) continue;

      const characterTags = scene?.continuity?.characterTags ?? [];
      const referenceImages = getSceneCharacterReferenceImages(
        allCharacters,
        characterTags
      );

      const workflowInput: ImageWorkflowInput = {
        userId: user.id,
        teamId,
        prompt,
        model: imageModelFor(shot),
        imageSize: aspectRatioToImageSize(sequence.aspectRatio),
        numImages: 1,
        shotId: shot.id,
        // The anchor + the prompt version `prompt` came from, snapshotted here
        // so the retry's variant is stamped with what it rendered (#1070).
        frameId: shot.frame.id,
        promptVersionId: promptVersion?.text ? promptVersion.id : null,
        sequenceId: sequence.id,
        referenceImages,
      };

      await triggerWorkflow('/image', workflowInput, {
        label: buildWorkflowLabel(sequence.id),
      });
      triggeredImages++;
    }

    if (triggeredImages > 0) retried.push(`${triggeredImages} image(s)`);
  }

  // 2. Retry failed motion
  if (failedMotionShots.length > 0) {
    let triggeredMotion = 0;
    for (const shot of failedMotionShots) {
      const imageUrl = shot.image?.url;
      if (!imageUrl) continue;

      const shotVideoModel = videoModelFor(shot);
      const scene = sceneOf(shot);
      const selectedMotion = selectedMotionByShot.get(shot.id) ?? null;
      const workflowInput: MotionWorkflowInput = {
        userId: user.id,
        teamId,
        shotId: shot.id,
        sceneId: shot.sceneId,
        sequenceId: sequence.id,
        imageUrl,
        // The versions this clip renders from, pinned here so the render
        // manifest can't name rows a concurrent edit repointed to.
        frameVersionId: shot.image?.id ?? null,
        motionPromptVersionId: selectedMotion?.id ?? null,
        sequenceTitle: sequence.title,
        prompt: resolveMotionPromptFromVersion(
          selectedMotion,
          {
            characterTags: scene?.continuity?.characterTags,
            description: scene?.originalScript.extract ?? null,
          },
          shotVideoModel
        ),
        model: shotVideoModel,
        aspectRatio: sequence.aspectRatio,
        duration: shot.durationMs ? shot.durationMs / 1000 : undefined,
      };

      await triggerWorkflow('/motion', workflowInput, {
        label: buildWorkflowLabel(sequence.id),
      });
      triggeredMotion++;
    }

    if (triggeredMotion > 0) {
      retried.push(`${triggeredMotion} motion video(s)`);
    }
  }

  // 3. Retry failed music
  if (hasMusicFailure && sequence.musicPrompt) {
    const allShots = await context.scopedDb.shots.listBySequence(sequence.id);
    const totalDuration = sumShotDurationsSeconds(allShots);

    const musicInput: MusicWorkflowInput = {
      userId: user.id,
      teamId,
      sequenceId: sequence.id,
      prompt: sequence.musicPrompt,
      tags: sequence.musicTags ?? '',
      duration: totalDuration || 30,
    };

    await context.scopedDb.sequence(sequence.id).updateMusicFields({
      musicStatus: 'generating',
      musicError: null,
    });

    await triggerWorkflow('/music', musicInput, {
      label: buildWorkflowLabel(sequence.id),
    });

    retried.push('music');
  }

  // 3b. Retry missing music prompt (use scenes fallback for LLM generation)
  if (
    !sequence.musicPrompt &&
    sequence.musicStatus !== 'completed' &&
    sequence.status === 'failed'
  ) {
    const allShots = await context.scopedDb.shots.listBySequence(sequence.id);
    const scenes = buildMusicSceneSummaries(
      allShots.flatMap((shot) => {
        const scene = sceneOf(shot);
        return scene ? [scene] : [];
      })
    );
    const totalDuration = sumShotDurationsSeconds(allShots);

    // Generate music prompt
    await triggerWorkflow<MusicPromptWorkflowInput>(
      '/music-prompt',
      {
        userId: user.id,
        teamId,
        sequenceId: sequence.id,
        sceneSummaries: scenes,
        analysisModelId:
          getAnalysisModelById(sequence.analysisModel)?.id ??
          DEFAULT_ANALYSIS_MODEL,
        duration: totalDuration || 30,
        // This branch only runs when the sequence has no music prompt at all.
        promptSource: 'ai-generated',
      },
      { label: buildWorkflowLabel(sequence.id) }
    );

    retried.push('music prompt');
  }

  // Nothing matched a retryable shape (e.g. every failed shot is missing
  // the prompt needed to regenerate it). Throw instead of falling through
  // to the status reset — silently flipping the sequence to 'completed'
  // with zero work in flight is exactly the lying-status class #839 is
  // about.
  if (retried.length === 0) {
    throw new Error(
      'None of the failed items can be retried automatically — regenerate the sequence instead.'
    );
  }

  // Clear the sequence-level 'failed' flag now that retries are in flight.
  // 'completed' (not 'processing') is deliberate: partial regeneration
  // tracks progress at the item level (shot thumbnail/video statuses,
  // sequence musicStatus) — same as regenerating a single shot from a
  // completed sequence — and a 'processing' row would be falsely
  // reconciled against the previous terminal workflowRunId by the cron
  // sweep's sequences.status pass. If a retry fails again, the item-level
  // status flips back to 'failed' and the failure summary reappears.
  if (sequence.status === 'failed') {
    await context.scopedDb.sequence(sequence.id).updateStatus('completed');
  }

  return { retryType: 'smart' as const, retriedItems: retried };
}
