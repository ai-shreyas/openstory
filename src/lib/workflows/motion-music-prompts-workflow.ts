/**
 * Cloudflare Workflows port of `motionMusicPromptsWorkflow`.
 *
 * Wave 3 mid-tier orchestrator: fans out to motion-prompts (per-scene tree)
 * and music-prompt (single scene-summaries → music design call) in parallel.
 *
 * Mirrors the QStash version (`src/lib/workflows/motion-music-prompts-workflow.ts`)
 * step for step — same step names, same control flow, same side effects.
 * The only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads payload from `event.payload` instead of `context.requestPayload`.
 *   - Replaces `Promise.all([context.invoke(...), context.invoke(...)])` with
 *     two parallel `spawnAndAwaitChild` calls (Pattern 3 from
 *     docs/investigations/cloudflare-workflows.md §4 Gap A).
 * */

import { DEFAULT_VIDEO_MODEL } from '@/lib/ai/models';
import type { MotionPrompt, Scene } from '@/lib/ai/scene-analysis.schema';
import type { ScopedDb } from '@/lib/db/scoped';
import { snapDuration } from '@/lib/motion/motion-generation';
import { reinforceInstrumentalTags } from '@/lib/prompts/music-prompt';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { spawnAndAwaitChild } from '@/lib/workflow/await-child';
import type {
  MotionMusicPromptsWorkflowInput,
  MotionMusicPromptsWorkflowResult,
  MotionPromptBatchWorkflowInput,
  MusicPromptWorkflowInput,
  MusicPromptWorkflowResult,
} from '@/lib/workflow/types';
import { buildMusicSceneSummaries } from '@/lib/workflows/music-scene-summaries';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'motion-music-prompts']);

type MotionPromptsResult = { sceneId: string; motionPrompt: MotionPrompt }[];

export class MotionMusicPromptsWorkflow extends OpenStoryWorkflowEntrypoint<MotionMusicPromptsWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<MotionMusicPromptsWorkflowInput>>,
    step: WorkflowStep,
    _scopedDb: ScopedDb
  ): Promise<MotionMusicPromptsWorkflowResult> {
    const input = event.payload;
    const {
      scenesWithVisualPrompts,
      analysisModelId,
      videoModel,
      videoModels,
      sequenceId,
      userId,
      teamId,
      aspectRatio,
      characterBible,
      locationBible,
      elementBible,
      styleConfig,
      shotMapping,
      startingFrameImageUrls,
      visualSummaryBySceneId,
    } = input;

    // Snap durations against the primary video model. The structured motion
    // prompts produced here are model-independent; per-model assembly happens
    // downstream in motion-batch (#545).
    const modelKey = videoModels?.[0] ?? videoModel ?? DEFAULT_VIDEO_MODEL;

    // Snap durations upfront so both motion prompts and music design see
    // identical, model-accurate duration values.
    const scenesWithSnappedDurations: Scene[] = await step.do(
      'snap-durations',
      () =>
        Promise.resolve(
          scenesWithVisualPrompts.map((scene) => ({
            ...scene,
            metadata: scene.metadata
              ? {
                  ...scene.metadata,
                  durationSeconds: snapDuration(
                    scene.metadata.durationSeconds,
                    modelKey
                  ),
                }
              : scene.metadata,
          }))
        )
    );

    // Build scene summaries for music design (uses snapped durations).
    const sceneSummaries = buildMusicSceneSummaries(
      scenesWithSnappedDurations,
      visualSummaryBySceneId
    );

    // Run motion prompts and music design in parallel via Pattern 3.
    const [motionPrompts, musicDesign] = await Promise.all([
      spawnAndAwaitChild<MotionPromptBatchWorkflowInput, MotionPromptsResult>(
        step,
        {
          binding: this.env.MOTION_PROMPT_BATCH_WORKFLOW,
          parentBindingName: 'MOTION_MUSIC_PROMPTS_WORKFLOW',
          parentInstanceId: event.instanceId,
          childId: `motion-prompts-batch:${sequenceId}`,
          childPayload: {
            userId,
            teamId,
            sequenceId,
            scenes: scenesWithSnappedDurations,
            aspectRatio,
            characterBible,
            locationBible,
            elementBible,
            styleConfig,
            analysisModelId,
            shotMapping,
            startingFrameImageUrls,
          },
          spawnStepName: 'spawn-motion-prompts',
          awaitStepName: 'await-motion-prompts',
          // Must exceed the child's own await budget: motion-prompts awaits
          // each per-scene grandchild for 30 minutes, plus notify lag under a
          // burst.
          timeout: '45 minutes',
        }
      ),
      spawnAndAwaitChild<MusicPromptWorkflowInput, MusicPromptWorkflowResult>(
        step,
        {
          binding: this.env.MUSIC_PROMPT_WORKFLOW,
          parentBindingName: 'MOTION_MUSIC_PROMPTS_WORKFLOW',
          parentInstanceId: event.instanceId,
          childId: `music-prompt:${sequenceId}`,
          childPayload: {
            userId,
            teamId,
            sequenceId,
            sceneSummaries,
            analysisModelId,
          },
          spawnStepName: 'spawn-music-prompt',
          awaitStepName: 'await-music-prompt',
          // LLM-only child; headroom is for burst notify lag.
          timeout: '45 minutes',
        }
      ),
    ]);

    // Merge music design into scenes.
    const completeScenes: Scene[] = await step.do(
      'merge-music-and-motion',
      () =>
        Promise.resolve(
          scenesWithSnappedDurations.map((scene) => {
            const motionPrompt = motionPrompts.find(
              (s) => s.sceneId === scene.sceneId
            );
            if (!motionPrompt) {
              throw new NonRetryableError(
                `Scene ID mismatch in motion prompts: expected "${scene.sceneId}"`,
                'WorkflowValidationError'
              );
            }
            const musicSceneDesign = musicDesign.scenes.find(
              (s) => s.sceneId === scene.sceneId
            );

            // The motion prompt is persisted to `shot_prompt_versions` by the
            // per-scene motion child (mirrored on `shot.motionPrompt`) — it is
            // NOT merged back into `scene.prompts` (#713). Only music design
            // rides on the scene metadata here.
            return {
              ...scene,
              musicDesign: musicSceneDesign?.musicDesign,
            };
          })
        )
    );

    // Return the generated motion prompts in memory, keyed by sceneId, so the
    // parent pipeline (analyze-script) threads them straight into the motion
    // render batch rather than re-reading the racy `shot.motionPrompt` mirror /
    // selected-version pointer from the DB (#713/#991). The per-scene child has
    // already persisted them to `shot_prompt_versions`.
    const motionPromptsBySceneId: Record<string, MotionPrompt> =
      Object.fromEntries(motionPrompts.map((m) => [m.sceneId, m.motionPrompt]));

    // `aspectRatio`, `characterBible`, `locationBible`, `elementBible`,
    // `styleConfig`, and `shotMapping` are passed through to the stubbed
    // motion-prompts child once the Pattern 3 batch ports it. They're left
    // off this orchestrator's destructure for now to keep tsgo happy.
    return {
      completeScenes,
      motionPromptsBySceneId,
      musicPrompt: musicDesign.prompt,
      musicTags: reinforceInstrumentalTags(musicDesign.tags),
    };
  }

  protected override onFailure({
    error,
  }: {
    event: Readonly<WorkflowEvent<MotionMusicPromptsWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): void {
    logger.error(
      `[MotionMusicPromptsWorkflow:cf] Motion/music prompt generation failed: ${error}`
    );
  }
}
