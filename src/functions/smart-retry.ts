/**
 * Smart Retry Server Function
 * Detects what failed in a sequence and only retries those parts.
 * Falls back to full storyboard retry when prompts are missing.
 */

import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  safeImageToVideoModel,
  safeTextToImageModel,
} from '@/lib/ai/models';
import {
  resolveImageModel,
  resolveVideoModel,
} from '@/lib/ai/resolve-asset-models';
import {
  estimateImageCost,
  estimateStoryboardCost,
  estimateVideoCost,
} from '@/lib/billing/cost-estimation';
import { addMicros, ZERO_MICROS } from '@/lib/billing/money';
import { requireCredits } from '@/lib/billing/preflight';
import { aspectRatioToImageSize } from '@/lib/constants/aspect-ratios';
import type { ScopedDb } from '@/lib/db/scoped';
import { type Character, type Sequence } from '@/lib/db/schema';
import { analyzeFailures } from '@/lib/failures/failure-analysis';
import { resolveMotionPromptFromVersion } from '@/lib/motion/resolve-motion-prompt';
import { projectShotWithImage } from '@/lib/shots/shot-with-image';
import { buildCharacterReferenceImages } from '@/lib/prompts/character-prompt';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import {
  assertNoActiveStoryboard,
  triggerStoryboard,
} from '@/lib/workflow/launchers';
import type {
  ImageWorkflowInput,
  MotionWorkflowInput,
  MusicWorkflowInput,
  StoryboardWorkflowInput,
} from '@/lib/workflow/types';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { sequenceAccessMiddleware } from './middleware';
import { buildSceneSummaries } from './sequences';

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
  // The still-image surface lives on each shot's anchor frame now (#989).
  // Project it back under the legacy thumbnail*/image* names — keyed by shotId,
  // never by id-reuse — so the failure analysis and per-shot retry reads below
  // are unchanged.
  await context.scopedDb.shots.ensureAnchorFrames(shots);
  const anchorsByShot = new Map(
    (await context.scopedDb.frames.listAnchorsBySequence(sequence.id)).map(
      (fr) => [fr.shotId, fr]
    )
  );
  const shotsWithImage = shots.flatMap((shot) => {
    const frame = anchorsByShot.get(shot.id);
    return frame ? [projectShotWithImage(shot, frame)] : [];
  });
  const summary = analyzeFailures(shotsWithImage, sequence);

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
      estimateStoryboardCost({
        imageModel,
        aspectRatio: sequence.aspectRatio,
        videoModels: [videoModel],
      }),
      {
        providers: ['fal', 'openrouter'],
        errorMessage: 'Insufficient credits to retry storyboard',
      }
    );

    const workflowInput: StoryboardWorkflowInput = {
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
    };

    // Owns the generation mutex, the 'processing' status write, and the
    // run-id persistence (#839).
    await triggerStoryboard(context.scopedDb, workflowInput);

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
  const imageModelFor = (shot: (typeof shotsWithImage)[number]) =>
    resolveImageModel({
      lastFailedAttemptModel: failedImageModels.get(shot.id),
      selectedVersionModel: selectedImageModels.get(shot.id),
      sequenceModel: sequence.imageModel,
    });
  const videoModelFor = (shot: (typeof shotsWithImage)[number]) =>
    resolveVideoModel({
      lastFailedAttemptModel: failedVideoModels.get(shot.id),
      selectedVersionModel: selectedVideoModels.get(shot.id),
      sequenceModel: sequence.videoModel,
    });

  // Collect failed items and estimate costs
  const failedImageShots = shotsWithImage.filter(
    (f) => f.thumbnailStatus === 'failed'
  );
  const failedMotionShots = shotsWithImage.filter(
    (f) => f.videoStatus === 'failed' && f.thumbnailUrl && f.motionPrompt
  );
  const hasMusicFailure =
    sequence.musicStatus === 'failed' && sequence.musicPrompt;

  // Calculate total cost — sum per shot since scenes may use different models.
  for (const shot of failedImageShots) {
    totalCost = addMicros(
      totalCost,
      estimateImageCost(imageModelFor(shot), sequence.aspectRatio, 1)
    );
  }

  if (failedMotionShots.length > 0) {
    const { snapDuration } = await import('@/lib/motion/motion-generation');
    for (const shot of failedMotionShots) {
      const model = videoModelFor(shot);
      totalCost = addMicros(
        totalCost,
        estimateVideoCost(model, snapDuration(undefined, model))
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
      const prompt = shot.imagePrompt || shot.description;

      if (!prompt) continue;

      const characterTags = shot.metadata?.continuity?.characterTags ?? [];
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
      if (!shot.thumbnailUrl) continue;

      const shotVideoModel = videoModelFor(shot);
      const selectedMotion =
        await context.scopedDb.shotPromptVersions.getSelectedMotion(shot.id);
      const workflowInput: MotionWorkflowInput = {
        userId: user.id,
        teamId,
        shotId: shot.id,
        sequenceId: sequence.id,
        imageUrl: shot.thumbnailUrl,
        prompt: resolveMotionPromptFromVersion(
          selectedMotion,
          {
            motionPromptMirror: shot.motionPrompt,
            characterTags: shot.metadata?.continuity?.characterTags,
            description: shot.description,
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
    const totalDuration = allShots.reduce((sum, shot) => {
      const seconds = shot.durationMs
        ? shot.durationMs / 1000
        : (shot.metadata?.metadata?.durationSeconds ?? 10);
      return sum + seconds;
    }, 0);

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
    const scenes = buildSceneSummaries(allShots);
    const totalDuration = allShots.reduce((sum, shot) => {
      const seconds = shot.durationMs
        ? shot.durationMs / 1000
        : (shot.metadata?.metadata?.durationSeconds ?? 10);
      return sum + seconds;
    }, 0);

    // Generate music prompt
    await triggerWorkflow(
      '/music-prompt',
      {
        userId: user.id,
        teamId,
        sequenceId: sequence.id,
        sceneSummaries: scenes,
        analysisModelId: sequence.analysisModel,
        duration: totalDuration || 30,
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

export const smartRetryFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(zodValidator(z.object({ sequenceId: ulidSchema })))
  .handler(({ context }) => executeSmartRetry(context));
