/**
 * Cloudflare Workflows port of `motionBatchWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/motion-batch-workflow.ts`)
 * step for step — same control flow, same side effects. Differences (all
 * infrastructure-level, not behavioural):
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads payload from `event.payload` and the run id from
 *     `event.instanceId` instead of `context.requestPayload` /
 *     `context.workflowRunId`.
 *   - Each `context.invoke(...)` becomes a Pattern 3 `spawnAndAwaitChild`
 *     against the relevant binding (MOTION_WORKFLOW × N shots, optional
 *     MUSIC_WORKFLOW). There is no server-side video merge step — playback
 *     and the final MP4 are produced client-side (Mediabunny browser export).
 *   - Fan-out: `Promise.all` on spawn (parents block until every child has
 *     been queued so a transient spawn failure surfaces as a workflow error
 *     rather than a silently-skipped child), `Promise.allSettled` on await
 *     so a single bad shot doesn't kill the rest of the batch. */

import { resolveAudioModels } from '@/lib/ai/resolve-audio-models';
import type { ScopedDb } from '@/lib/db/scoped';
import { assembleMotionPrompt } from '@/lib/motion/assemble-motion-prompt';
import { getGenerationChannel } from '@/lib/realtime';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { spawnAndAwaitChild } from '@/lib/workflow/await-child';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import { buildMotionJobs } from '@/lib/workflows/motion-batch-jobs';
import type {
  BatchMotionMusicWorkflowInput,
  MotionWorkflowInput,
  MotionWorkflowResult,
  MusicWorkflowInput,
  MusicWorkflowResult,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'motion-batch']);

type MotionBatchWorkflowResult = {
  sequenceId: string;
};

export class MotionBatchWorkflow extends OpenStoryWorkflowEntrypoint<BatchMotionMusicWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<BatchMotionMusicWorkflowInput>>,
    step: WorkflowStep,
    // Fan-out uses workflow bindings, not direct DB access; the merge steps
    // that read shots were removed (browser-side merge). Kept for signature
    // parity with the abstract runImpl.
    _scopedDb: ScopedDb
  ): Promise<MotionBatchWorkflowResult> {
    const input = event.payload;
    const parentInstanceId = event.instanceId;
    const { sequenceId, includeMusic } = input;

    if (!sequenceId) {
      throw new WorkflowValidationError('sequenceId is required');
    }
    if (!input.shots.length) {
      throw new WorkflowValidationError('At least one shot is required');
    }
    if (includeMusic && !input.music) {
      throw new WorkflowValidationError(
        'music config is required when includeMusic is true'
      );
    }

    // Step 1: Fan out motion workflows + optional music workflow in parallel.
    // Multi-model video (#545): one MOTION_WORKFLOW child per (shot, model)
    // — the motion analog of shot-images' per-(scene, model) fan-out (see
    // `buildMotionJobs` for the resolution/dedupe rules). The first model is
    // primary (its output also lands in the legacy `shots.video*` columns);
    // the rest are alternates in `shot_variants`. Pattern 3 spawns + awaits
    // each child via `spawnAndAwaitChild`; Promise.allSettled lets a single
    // failing (shot, model) not poison the rest of the batch.
    const motionJobs = buildMotionJobs(input.shots, input.videoModels);

    const motionAwaits = motionJobs.map(({ shot, shotIndex, model }) => {
      // Per-model prompt: re-assemble from the structured motion prompt when
      // present so audio-capable models get dialogue/audio sections, falling
      // back to the pre-assembled `prompt` for manual single-model paths.
      const prompt = shot.motionPrompt
        ? assembleMotionPrompt({
            motionPrompt: shot.motionPrompt,
            model,
            characterTags: shot.characterTags,
          })
        : shot.prompt;

      const motionBody: MotionWorkflowInput = {
        userId: input.userId,
        teamId: input.teamId,
        shotId: shot.shotId,
        sequenceId,
        imageUrl: shot.imageUrl,
        prompt,
        model,
        duration: shot.duration,
        fps: shot.fps,
        motionBucket: shot.motionBucket,
        aspectRatio: shot.aspectRatio,
        generateAudio: shot.generateAudio,
        userEditProvenance: shot.userEditProvenance,
        sceneTitle: shot.sceneTitle,
        priorMotion: shot.priorMotion,
        // Cast/element reference images (#873) — only Kling v3 Pro emits them.
        referenceImages: shot.referenceImages,
        // Add-model (#547) batches generate alternates only — the child must
        // not write the legacy `shots.video*` columns.
        variantOnly: input.variantOnly,
      };

      return spawnAndAwaitChild<MotionWorkflowInput, MotionWorkflowResult>(
        step,
        {
          binding: this.env.MOTION_WORKFLOW,
          parentBindingName: 'MOTION_BATCH_WORKFLOW',
          parentInstanceId,
          // The model token keeps sibling-model children from colliding on the
          // global CF instance id (mirrors shot-images' childId scheme).
          childId: `motion:${sequenceId}:${shot.shotId}:${model}`,
          childPayload: motionBody,
          spawnStepName: `spawn-motion-${shotIndex}-${model}`,
          awaitStepName: `await-motion-${shotIndex}-${model}`,
          // Must exceed the child's own budget: motion polls fal for up to
          // 30 minutes (MAX_BATCHES in motion-workflow.ts) plus submit/
          // compress/persist steps and notify lag under a burst.
          timeout: '45 minutes',
        }
      );
    });

    // Multi-model audio (#546): one MUSIC_WORKFLOW child per selected model,
    // each reusing the same prompt/tags/duration and writing its own primary
    // row in sequence_music_variants (keyed by (sequenceId, model)). Only the
    // first model is primary — it alone writes the live `sequences.music*`
    // columns; the rest persist only their variant row (see `isPrimary` below).
    // Falls back to the single `music.model` when no audioModels were threaded.
    const audioModels =
      includeMusic && input.music
        ? resolveAudioModels(input.audioModels, input.music.model)
        : [];

    const musicJobs =
      includeMusic && input.music
        ? audioModels.map((model) => ({ model }))
        : [];

    const musicAwaits = musicJobs.map(({ model }, index) => {
      // input.music is narrowed truthy by musicJobs construction above.
      const music = input.music;
      if (!music) {
        throw new WorkflowValidationError('music config missing for batch');
      }
      return spawnAndAwaitChild<MusicWorkflowInput, MusicWorkflowResult>(step, {
        binding: this.env.MUSIC_WORKFLOW,
        parentBindingName: 'MOTION_BATCH_WORKFLOW',
        parentInstanceId,
        childId: `music:${sequenceId}:${model}`,
        childPayload: {
          userId: input.userId,
          teamId: input.teamId,
          sequenceId,
          prompt: music.prompt,
          tags: music.tags,
          duration: music.duration,
          model,
          // audioModels[0] is primary (resolveAudioModels preserves order +
          // dedupes); only it writes the live `sequences.music*` columns.
          isPrimary: index === 0,
        },
        spawnStepName: `spawn-music-${index}-${model}`,
        awaitStepName: `await-music-${index}-${model}`,
        // Same budget as the motion children — queue backlog under a burst
        // applies to audio generation too.
        timeout: '45 minutes',
      });
    });

    const motionResults = await Promise.allSettled(motionAwaits);
    const musicResults = musicAwaits.length
      ? await Promise.allSettled(musicAwaits)
      : null;

    // Log per-shot motion failures for visibility; we don't throw here — the
    // QStash original uses Promise.all + a single combined await, but parity
    // with the rest of the CF batch surface (shot-images) is to allSettle
    // and rely on the collect step below to validate that we have something
    // mergeable.
    for (let i = 0; i < motionResults.length; i++) {
      const r = motionResults[i];
      if (r?.status === 'rejected') {
        const job = motionJobs[i];
        // Include the reason in the message itself — structured `err` fields
        // don't reliably survive into the log body (the June 7 run produced
        // bare "Motion failed for shot …:" lines with no cause attached).
        logger.warn(
          `[MotionBatchWorkflow:cf] Motion failed for shot ${job?.shot.shotId ?? '(unknown)'} model ${job?.model ?? '(unknown)'}: ${String(r.reason)}`,
          {
            err: r.reason,
          }
        );
      }
    }
    if (musicResults) {
      for (let i = 0; i < musicResults.length; i++) {
        const m = musicResults[i];
        if (m?.status === 'rejected') {
          logger.warn(
            `[MotionBatchWorkflow:cf] Music generation failed for sequence ${sequenceId} model ${musicJobs[i]?.model ?? '(unknown)'}: ${String(m.reason)}`,
            {
              err: m.reason,
            }
          );
        }
      }
    }

    // Playback and the final MP4 are produced client-side by
    // `<SequencePlayer>` / the Mediabunny browser export — there is no
    // server-side video merge step (parity with the QStash motion-batch).
    return { sequenceId };
  }

  protected override async onFailure({
    event,
    error,
  }: {
    event: Readonly<WorkflowEvent<BatchMotionMusicWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): Promise<void> {
    const input = event.payload;

    if (input.sequenceId) {
      try {
        await getGenerationChannel(input.sequenceId).emit('generation.failed', {
          message: error,
        });
      } catch (emitError) {
        logger.error(
          `[MotionBatchWorkflow:cf] Failed to emit generation.failed for sequence ${input.sequenceId}:`,
          {
            err: emitError,
          }
        );
      }
    }

    logger.error(
      `[MotionBatchWorkflow:cf] Failed for sequence ${input.sequenceId}: ${error}`
    );
  }
}
