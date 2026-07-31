/**
 * Cloudflare Workflows port of `generateMotionWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/motion-workflow.ts`) step
 * for step — same step names, same control flow, same side effects. The
 * only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run` and `step.sleep` instead of
 *     `context.sleep`.
 *   - Reads the workflow run id from `event.instanceId` instead of
 *     `context.workflowRunId`.
 *   - Throws `NonRetryableError` from `cloudflare:workflows` in place of
 *     the old Upstash workflow `WorkflowNonRetryableError`. */

import {
  CONTENT_REJECTION_EVENT,
  CONTENT_REJECTION_RETRY_EVENT,
  isContentRejectionError,
} from '@/lib/ai/content-rejection';
import { falCostFromUnits } from '@/lib/ai/fal-cost';
import { extractFalErrorMessage } from '@/lib/ai/fal-error';
import {
  computeMotionPromptInputHash,
  computeVideoManifestInputHash,
} from '@/lib/ai/input-hash';
import { DEFAULT_VIDEO_MODEL, IMAGE_TO_VIDEO_MODELS } from '@/lib/ai/models';
import { loadNarrowShotPromptContext } from '@/lib/ai/prompt-context';
import { microsToUsd, type Microdollars } from '@/lib/billing/money';
import {
  deductWorkflowCredits,
  falUsageMetadata,
  recordFalUsage,
} from '@/lib/billing/workflow-deduction';
import type { ScopedDb } from '@/lib/db/scoped';
import { ensureImageUnderLimit } from '@/lib/image/image-compress';
import {
  calculateMotionMetadata,
  pollMotionJob,
  submitMotionJob,
} from '@/lib/motion/motion-generation';
import { getEffectiveFalPricing } from '@/lib/ai/fal-pricing-live';
import { gateEstimate } from '@/lib/billing/cost-estimation';
import { buildVideoManifest } from '@/lib/motion/render-segments';
import { resolveMotionEndpoint } from '@/lib/motion/resolve-motion-endpoint';
import { uploadVideoToStorage } from '@/lib/motion/video-storage';
import { getLogger } from '@/lib/observability/logger';
import { endSpanSuccess, startGenAISpan } from '@/lib/observability/tracer';
import { getGenerationChannel } from '@/lib/realtime';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type { MotionWorkflowInput } from '@/lib/workflow/types';
import {
  buildMotionGeneratingShotWrite,
  persistMotionCompletion,
  persistMotionFailure,
} from '@/lib/workflows/motion-workflow-persist';
import { shouldRecordUserEdit } from '@/lib/workflows/user-edit-predicate';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

const logger = getLogger(['openstory', 'workflow', 'motion']);

/** Each batch polls in a tight loop for ~30s, then checkpoints for durability */
const POLL_BATCH_DURATION_MS = 30_000;
const POLL_INTERVAL_MS = 3_000;
/**
 * 60 batches × 30s = 30 minutes of polling. Under a many-sequence burst the
 * fal queue alone can hold a job past 15 minutes (the June 7 sample run lost
 * 13 shots to the old 30-batch budget while ~95% of jobs completed fine), so
 * the budget must absorb provider-side queueing — motion-batch's per-child
 * await (45 minutes) stays comfortably above it.
 */
const MAX_BATCHES = 60;
/** Kling rejects start shot images over 10MB — use 9.5MB safety margin */
const KLING_MAX_IMAGE_BYTES = 9.5 * 1024 * 1024;

/**
 * Total clip generation attempts on a content-flag rejection (#881): the
 * initial attempt plus 2 resubmits. The veo "could not generate / didn't
 * generate expected output" rejections are largely stochastic and clear on a
 * fresh resubmit; deterministic content-checker / sensitive-audio hits exhaust
 * this budget and fail as before.
 */
const MAX_MOTION_ATTEMPTS = 3;

/** Per-attempt poll outcome. A content-flag rejection (`rejected`) re-rolls the
 *  whole submit→poll cycle; a non-content `failed` is a hard stop as today. */
type MotionPollOutcome =
  | { kind: 'pending' }
  | { kind: 'completed'; url: string; unitsBilled?: number }
  | { kind: 'rejected'; rejection: string }
  | { kind: 'failed'; error: string };

type MotionWorkflowResult = {
  videoUrl: string;
  duration: number;
};

/** Route a provider clip failure: a content flag re-rolls the attempt (#881);
 *  anything else is a hard stop, matching the pre-#881 behaviour. */
function classifyMotionFailure(message: string): MotionPollOutcome {
  return isContentRejectionError(message)
    ? { kind: 'rejected', rejection: message }
    : { kind: 'failed', error: `Motion generation failed: ${message}` };
}

function recordMotionObservation(params: {
  model: string;
  prompt: string;
  imageUrl: string;
  videoUrl: string;
  cost: Microdollars;
  videoDuration: number;
  generationTimeMs: number;
}) {
  const span = startGenAISpan('fal-motion', {
    model: params.model,
    provider: 'fal',
    operation: 'generate_content',
    input: { prompt: params.prompt, imageUrl: params.imageUrl },
    metadata: {
      videoDuration: params.videoDuration,
      generationTimeMs: params.generationTimeMs,
    },
  });
  span.setAttribute('gen_ai.usage.cost', microsToUsd(params.cost));
  endSpanSuccess(span, { videoUrl: params.videoUrl });
}

export class MotionWorkflow extends OpenStoryWorkflowEntrypoint<MotionWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<MotionWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<MotionWorkflowResult> {
    const rawInput = event.payload;
    // Back-compat: accept shotId or shotId from in-flight instances serialized before #906
    // TODO(#906): remove shotId shim one release after deploy
    const input = {
      ...rawInput,
      shotId:
        rawInput.shotId ??
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- back-compat shim for in-flight CF Workflow instances serialized before #906
        (rawInput as { shotId?: string }).shotId ??
        undefined,
    };
    const workflowRunId = event.instanceId;
    const model = input.model || DEFAULT_VIDEO_MODEL;

    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    if (!input.imageUrl?.trim()) {
      throw new WorkflowValidationError(
        'Thumbnail Path is required for motion generation'
      );
    }

    // Motion's dual-write (#545, re-routed to `video_variants` in #990) opens
    // this model's `video_variants` version in `set-generating-status` and
    // closes it in completion/`onFailure`, all of which need `sequenceId`. Every
    // trigger sets both ids; assert it once here so a `sequenceId`-less caller
    // fails loudly at the boundary rather than silently writing the legacy
    // columns while skipping the variant half (which would leave the model
    // invisible in the scenes-view switcher).
    if (input.shotId && !input.sequenceId) {
      throw new WorkflowValidationError(
        'sequenceId is required when shotId is set (motion dual-write)'
      );
    }

    // Step 0: Estimate cost and check the team can afford it. The estimate only
    // gates affordability — the exact charge is computed from fal's billed
    // units after the clip completes (see actualCost below).
    const { duration } = await step.do('check-credits', async () => {
      const { cost: estimatedCost, duration } = calculateMotionMetadata(
        {
          imageUrl: input.imageUrl,
          prompt: input.prompt,
          model,
          duration: input.duration,
          fps: input.fps,
          motionBucket: input.motionBucket,
          aspectRatio: input.aspectRatio,
          generateAudio: input.generateAudio,
        },
        await getEffectiveFalPricing()
      );
      // No honest estimate → gate on the conservative floor (#1069).
      const cost = gateEstimate(estimatedCost, {
        model,
        operation: 'motion-workflow',
      });

      const falKeyInfo = await scopedDb.apiKeys.resolveKey('fal');
      const usedOwnKey = falKeyInfo.source === 'team';
      if (cost > 0 && !usedOwnKey) {
        const canAfford = await scopedDb.billing.hasEnoughCredits(cost);
        if (!canAfford) {
          logger.warn(
            `[MotionWorkflow:cf] Insufficient credits for team ${input.teamId} (cost: $${microsToUsd(cost).toFixed(4)}), skipping deduction`
          );
          throw new NonRetryableError(
            `Insufficient credits for motion generation`
          );
        }
      }
      return { cost, duration };
    });

    // Step 1: Set status to generating and store model being used
    const { shotDeleted, videoVersionId, sceneId } = await step.do(
      'set-generating-status',
      async (): Promise<{
        shotDeleted: boolean;
        videoVersionId: string | null;
        sceneId: string | null;
      }> => {
        if (!input.shotId) {
          return { shotDeleted: false, videoVersionId: null, sceneId: null };
        }

        const generatingShotWrite = buildMotionGeneratingShotWrite({
          model,
          workflowRunId,
        });

        // Variant-only (#547): don't stamp the legacy `shots.video*` columns —
        // read the shot instead. The per-model `video_variants` version (opened
        // below) carries the in-flight state; the primary video is left intact.
        const shot = input.variantOnly
          ? await scopedDb.shots.getById(input.shotId)
          : await scopedDb.shots.update(input.shotId, generatingShotWrite, {
              throwOnMissing: false,
            });

        if (!shot) {
          logger.info(
            `[MotionWorkflow:cf] Shot ${input.shotId} was deleted, skipping workflow`
          );
          return { shotDeleted: true, videoVersionId: null, sceneId: null };
        }

        if (
          shouldRecordUserEdit({
            userEditedPrompt: input.userEditedPrompt,
            prompt: input.prompt,
            currentPrompt: shot.motionPrompt,
          })
        ) {
          let userEditInputHash: string | null = null;
          let userEditAnalysisModel: string | null = null;
          try {
            if (shot.metadata && input.sequenceId) {
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
                  // i2v anchor still lives on the anchor frame now (#989) —
                  // resolved by shotId, never by id-reuse.
                  startingFrameImageUrl:
                    (await scopedDb.frames.getAnchorByShot(shot.id))
                      ?.imageUrl ?? null,
                });
                userEditInputHash = await computeMotionPromptInputHash(ctx);
                userEditAnalysisModel = ctx.analysisModel;
              }
            }
          } catch (err) {
            logger.warn(
              `[MotionWorkflow:cf] Could not compute upstream hash for user-edit on shot ${input.shotId}; recording with null hash`,
              {
                err,
              }
            );
          }

          // Carry the dialogue/audio direction forward onto the user-edit
          // version so audio-capable models still get enrichment after a
          // raw-text edit (pre-#713 this came from `metadata.prompts.motion`,
          // now gone). The direction is captured at trigger time
          // (`input.priorMotion`) — NOT re-read here, which would be racy
          // against concurrent append-only version writes and replay-unsafe
          // (this very write repoints the selection pointer). `components` /
          // `parameters` stay null on a free-text edit, as they did pre-#713.
          await scopedDb.shotPromptVersions.write({
            shotId: input.shotId,
            promptType: 'motion',
            text: input.prompt,
            dialogue: input.priorMotion?.dialogue ?? null,
            audio: input.priorMotion?.audio ?? null,
            source: 'user-edit',
            inputHash: userEditInputHash,
            analysisModel: userEditAnalysisModel,
            createdBy: input.userId,
          });
        }

        // Open an append-only `video_variants` *version* for this render (#990,
        // replaces the retired `shot_variants` video slice). It is keyed by
        // (renderSegmentId, model); per-shot rendering is the degenerate
        // one-shot segment whose id is the shot's id. The manifest snapshots the
        // inputs the render consumes — the shot's selected motion-prompt + anchor-frame
        // image versions (the references ARE the snapshot) + the value-snapshot
        // duration. The legacy `shots.video*` columns above stay the cached
        // mirror of whichever version the shot's selection points at.
        const renderSceneId = shot.sceneId;
        let openedVideoVersionId: string | null = null;
        if (input.sequenceId) {
          if (!renderSceneId) {
            throw new WorkflowValidationError(
              `Shot ${input.shotId} has no scene; cannot open a video render version`
            );
          }
          // Resolve (materializing on first use) the shot's render segment —
          // per-shot rendering is the degenerate one-shot segment.
          const renderSegmentId = await scopedDb.renderSegments.ensureForShot({
            id: shot.id,
            sceneId: renderSceneId,
            sequenceId: input.sequenceId,
            renderSegmentId: shot.renderSegmentId,
          });
          const anchorFrame = await scopedDb.frames.getAnchorByShot(shot.id);
          const manifest = buildVideoManifest([
            {
              shotId: input.shotId,
              motionPromptVersionId: shot.selectedMotionPromptVersionId ?? null,
              frameVersionId: anchorFrame?.selectedImageVersionId ?? null,
              durationMs: duration * 1000,
            },
          ]);
          const version = await scopedDb.videoVariants.appendVersion({
            renderSegmentId,
            sequenceId: input.sequenceId,
            model,
            manifest,
            inputHash: await computeVideoManifestInputHash(manifest, model),
            status: 'generating',
            workflowRunId,
          });
          openedVideoVersionId = version.id;
          // Primary motion claims auto-promote; last kickoff wins (#1070).
          if (!input.variantOnly) {
            await scopedDb.renderSegments.setPendingPromoteVersionId(
              renderSegmentId,
              version.id
            );
          }
        }

        try {
          await getGenerationChannel(input.sequenceId).emit(
            'generation.video:progress',
            {
              shotId: input.shotId,
              status: 'generating',
              model,
              // Variant-only (#547): don't flip the primary shot to
              // "generating" in cache — this run only fills a variant version.
              variantOnly: input.variantOnly,
            }
          );
        } catch (emitError) {
          logger.error(
            `[MotionWorkflow:cf] Failed to emit generation.video:progress for shot ${input.shotId}:`,
            {
              err: emitError,
            }
          );
        }
        return {
          shotDeleted: false,
          videoVersionId: openedVideoVersionId,
          sceneId: renderSceneId,
        };
      }
    );

    if (shotDeleted) {
      return { videoUrl: '', duration: 0 };
    }

    // Step 2: Prepare start image — use Cloudflare Image Resizing if Kling model and image exceeds 10MB
    const startImageUrl = await step.do('prepare-start-image', async () => {
      const modelConfig = IMAGE_TO_VIDEO_MODELS[model];
      if (modelConfig.provider !== 'Kling') {
        return input.imageUrl;
      }

      const compressed = await ensureImageUnderLimit(
        input.imageUrl,
        KLING_MAX_IMAGE_BYTES
      );
      if (!compressed) {
        return input.imageUrl;
      }

      logger.info(
        `[MotionWorkflow:cf] Image ${(compressed.originalSizeBytes / 1024 / 1024).toFixed(1)}MB exceeds limit, using Cloudflare Image Resizing`
      );

      return compressed.url;
    });

    // Step 3: Submit + poll with a bounded same-model retry on content-flag
    // rejections (#881). Each attempt resubmits a fresh fal job; a content
    // rejection from submit OR poll re-rolls the whole cycle, while
    // genuine transient errors still throw and lean on CF's per-step retries.
    // Non-content provider failures remain a hard stop as before. A clip that
    // exhausts its budget fails only its own slot — motion-batch's
    // Promise.allSettled keeps sibling clips and the sequence alive.
    let videoUrl = '';
    // Real quantity fal billed for the clip that succeeded — drives the exact
    // credit deduction below (the check-credits estimate only gates affordability).
    let billedUnits: number | undefined;
    let lastRejection: string | null = null;
    // The job behind the clip that ultimately succeeded — its `submittedAt` /
    // `usedOwnKey` drive observation timing and credit deduction below.
    let succeededJob: Awaited<ReturnType<typeof submitMotionJob>> | null = null;

    for (let attempt = 0; attempt < MAX_MOTION_ATTEMPTS; attempt++) {
      const tag = attempt === 0 ? '' : `-retry-${attempt}`;

      // Step 3a: Submit. A content rejection surfaces as a sentinel (not
      // thrown) so the loop owns the retry; a non-content 422 stays a hard
      // stop; anything else throws for CF's per-step retry.
      const submitOutcome = await step.do(`submit-motion${tag}`, async () => {
        // Surface the same-model content-flag re-roll (#881) as in-flight retry
        // state so the scenes UI shows "Retrying (N/3)…" instead of a spinner
        // indistinguishable from a hang (#882). `attempt` is 0-indexed; show it
        // 1-based.
        if (attempt > 0 && input.shotId && input.sequenceId) {
          await getGenerationChannel(input.sequenceId).emit(
            'generation.video:progress',
            {
              shotId: input.shotId,
              status: 'generating',
              phase: 'retrying',
              attempt: attempt + 1,
              maxAttempts: MAX_MOTION_ATTEMPTS,
              model,
              variantOnly: input.variantOnly,
            }
          );
        }
        try {
          const job = await submitMotionJob({
            imageUrl: startImageUrl,
            prompt: input.prompt,
            model,
            duration: input.duration,
            fps: input.fps,
            motionBucket: input.motionBucket,
            aspectRatio: input.aspectRatio,
            generateAudio: input.generateAudio,
            // Cast/element reference images (#873) — only Kling v3 Pro emits them.
            referenceImages: input.referenceImages,
            scopedDb,
          });
          return { ok: true as const, job };
        } catch (error) {
          if (isContentRejectionError(error)) {
            return {
              ok: false as const,
              rejection: extractFalErrorMessage(error),
            };
          }
          if (
            error instanceof Error &&
            'status' in error &&
            error.status === 422
          ) {
            throw new NonRetryableError(
              `Motion job submission rejected (422): ${extractFalErrorMessage(error)}`
            );
          }
          // Not a 422 / not a content flag → transient. Let CF retry the step.
          throw error;
        }
      });

      if (!submitOutcome.ok) {
        lastRejection = submitOutcome.rejection;
        logger.warn(
          `[MotionWorkflow:cf] content-flag rejection on submit attempt ${attempt + 1}/${MAX_MOTION_ATTEMPTS} for shot ${input.shotId}: ${submitOutcome.rejection}`
        );
        continue;
      }
      const { job } = submitOutcome;

      // Step 3b: Batched polling — tight loop inside each step.do, checkpoint
      // between batches. A content-flag failure ends this attempt and re-rolls;
      // a non-content failure is a hard stop.
      let rejected: string | null = null;
      for (let batch = 0; batch < MAX_BATCHES; batch++) {
        if (batch > 0) {
          await step.sleep(`motion-batch-wait-${attempt}-${batch}`, 1);
        }

        const poll = await step.do(
          `motion-poll-batch-${attempt}-${batch}`,
          async (): Promise<MotionPollOutcome> => {
            const deadline = Date.now() + POLL_BATCH_DURATION_MS;

            while (Date.now() < deadline) {
              let pollResult: Awaited<ReturnType<typeof pollMotionJob>>;
              try {
                pollResult = await pollMotionJob(
                  job.jobId,
                  job.modelKey,
                  scopedDb
                );
              } catch (error) {
                if (isContentRejectionError(error)) {
                  return {
                    kind: 'rejected',
                    rejection: extractFalErrorMessage(error),
                  };
                }
                if (
                  error instanceof Error &&
                  'status' in error &&
                  error.status === 422
                ) {
                  return {
                    kind: 'failed',
                    error: `Motion job polling failed (422): ${extractFalErrorMessage(error)}`,
                  };
                }
                // Transient → let CF retry the poll step.
                throw error;
              }

              if (pollResult.progress !== undefined) {
                logger.info(
                  `[MotionWorkflow:cf] Progress: ${pollResult.progress}%`
                );
              }

              if (pollResult.status === 'completed') {
                if (pollResult.url) {
                  logger.info(`[MotionWorkflow:cf] Generation completed`);
                  return {
                    kind: 'completed',
                    url: pollResult.url,
                    unitsBilled: pollResult.usage?.unitsBilled,
                  };
                }
                return classifyMotionFailure(
                  pollResult.error || 'No URL returned'
                );
              }
              if (pollResult.status === 'failed') {
                return classifyMotionFailure(
                  pollResult.error || 'Unknown error'
                );
              }

              await new Promise((resolve) =>
                setTimeout(resolve, POLL_INTERVAL_MS)
              );
            }

            return { kind: 'pending' };
          }
        );

        if (poll.kind === 'completed') {
          videoUrl = poll.url;
          billedUnits = poll.unitsBilled;
          break;
        }
        if (poll.kind === 'rejected') {
          rejected = poll.rejection;
          break;
        }
        if (poll.kind === 'failed') {
          throw new NonRetryableError(poll.error);
        }
        // pending → poll the next batch
      }

      if (videoUrl) {
        succeededJob = job;
        if (attempt > 0) {
          logger.info(
            `[MotionWorkflow:cf] content-flag retry rescued clip for shot ${input.shotId} on attempt ${attempt + 1}`,
            {
              event: CONTENT_REJECTION_RETRY_EVENT,
              outcome: 'rescued',
              kind: 'motion',
              model,
              attempts: attempt + 1,
              shotId: input.shotId,
              sequenceId: input.sequenceId,
            }
          );
        }
        break;
      }

      if (rejected) {
        lastRejection = rejected;
        logger.warn(
          `[MotionWorkflow:cf] content-flag rejection on poll attempt ${attempt + 1}/${MAX_MOTION_ATTEMPTS} for shot ${input.shotId}: ${rejected}`
        );
        continue;
      }

      // Neither completed nor content-rejected → this attempt timed out. A
      // timeout isn't a content flag; reseeding won't help and would burn
      // another full poll budget, so stop here as before.
      throw new Error(
        `Motion generation timed out after ${(MAX_BATCHES * POLL_BATCH_DURATION_MS) / 60_000} minutes`
      );
    }

    if (!videoUrl) {
      logger.error(
        `[MotionWorkflow:cf] content-flag retry exhausted for shot ${input.shotId} after ${MAX_MOTION_ATTEMPTS} attempts`,
        {
          event: CONTENT_REJECTION_RETRY_EVENT,
          outcome: 'exhausted',
          kind: 'motion',
          model,
          attempts: MAX_MOTION_ATTEMPTS,
          shotId: input.shotId,
          sequenceId: input.sequenceId,
          rejection: lastRejection,
        }
      );
      throw new NonRetryableError(
        `Motion generation rejected by content filter after ${MAX_MOTION_ATTEMPTS} attempts: ${lastRejection ?? 'unknown rejection'}`,
        'ContentRejectionExhausted'
      );
    }
    if (!succeededJob) {
      // Unreachable: a non-empty videoUrl is only ever set alongside its job.
      throw new Error('Motion generation produced a video without a job');
    }
    // Capture into a const so the step closures below keep the non-null
    // narrowing (a `let` could be reassigned, so TS widens it inside closures).
    const job = succeededJob;

    // Exact charge from fal's reported billed units (the check-credits `cost`
    // was only an estimate for the affordability gate). Price against the
    // endpoint actually submitted to — Seedance with refs bills on its
    // reference-to-video endpoint, not image-to-video (#873).
    const { endpointId: billedEndpointId } = resolveMotionEndpoint(
      model,
      (input.referenceImages?.length ?? 0) > 0
    );
    const actualCost = await falCostFromUnits(billedEndpointId, billedUnits);

    await step.do('record-motion-observation', async () => {
      recordMotionObservation({
        model,
        prompt: input.prompt,
        imageUrl: input.imageUrl,
        videoUrl,
        cost: actualCost,
        videoDuration: duration,
        generationTimeMs: Date.now() - job.submittedAt,
      });
    });

    const falUsage = falUsageMetadata({
      endpointId: billedEndpointId,
      unitsBilled: billedUnits,
    });

    // Outside the deduction guard below: a BYOK or unpriced generation bills
    // the same units as a charged one, and is the only route off the
    // unknown-estimate floor for a model we can't price yet (#1069).
    await step.do('record-fal-usage', async () => {
      await recordFalUsage(scopedDb, falUsage);
    });

    // Deduct credits (skip if team used own fal key). Routed through
    // deductWorkflowCredits so insufficient balances warn-and-skip (with an
    // auto-top-up attempt) like every other workflow, instead of debiting
    // the balance negative.
    if (actualCost > 0 && input.teamId && !job.usedOwnKey) {
      await step.do('deduct-credits', async () => {
        await deductWorkflowCredits({
          scopedDb,
          costMicros: actualCost,
          usedOwnKey: job.usedOwnKey,
          description: `Motion generation (${model})`,
          idempotencyKey: `${event.instanceId}:motion`,
          metadata: {
            ...falUsage,
            model,
            shotId: input.shotId,
            sequenceId: input.sequenceId,
            duration: duration,
          },
          workflowName: 'MotionWorkflow:cf',
        });
      });
    }

    if (input.shotId) {
      const { shotId } = input;

      // Step 3: Fetch shot and sequence data for human-readable filename
      const shotData = await step.do('fetch-shot-data', async () => {
        const shot = await scopedDb.shots.getWithSequence(shotId);
        if (!shot) throw new Error('Shot not found');
        return {
          sequenceTitle: shot.sequence.title,
          sceneTitle: shot.metadata?.metadata?.title,
        };
      });

      // Step 4: Upload video to storage
      const storageResult = await step.do('upload-to-storage', async () => {
        if (!input.teamId || !input.sequenceId) {
          throw new Error('Missing teamId or sequenceId for storage upload');
        }

        const result = await uploadVideoToStorage({
          videoUrl,
          teamId: input.teamId,
          sequenceId: input.sequenceId,
          shotId,
          sequenceTitle: shotData.sequenceTitle,
          sceneTitle: shotData.sceneTitle,
        });

        if (!result.success) {
          throw new Error('Failed to upload video');
        }

        return { path: result.path, url: result.url };
      });

      videoUrl = storageResult.url;

      // Step 5: Finalize the render — flip the `video_variants` version to
      // `completed` and (for a primary render) repoint the shot's selection,
      // mirroring `shots.video*` + the render segment's selection pointer (#990,
      // see motion-workflow-persist).
      await step.do('update-shot', async () => {
        if (!videoVersionId || !sceneId || !input.sequenceId) {
          // No open version (shotId present without the sequence-scoped
          // dual-write) — nothing to finalize. The set-generating guard makes
          // this unreachable for real triggers; logged for safety.
          logger.warn(
            `[MotionWorkflow:cf] No video version to finalize for shot ${shotId}; skipping`
          );
          return;
        }
        const outcome = await persistMotionCompletion({
          scopedDb,
          shotId,
          sequenceId: input.sequenceId,
          sceneId,
          videoVersionId,
          model,
          upload: { url: storageResult.url, path: storageResult.path },
          actorId: input.userId,
          variantOnly: input.variantOnly,
          emit: async (event, payload) => {
            try {
              await getGenerationChannel(input.sequenceId).emit(event, payload);
            } catch (emitError) {
              logger.error(
                `[MotionWorkflow:cf] Failed to emit generation.video:progress for shot ${shotId}:`,
                { err: emitError }
              );
            }
          },
        });

        if (outcome.status === 'shot-deleted') {
          logger.info(
            `[MotionWorkflow:cf] Shot ${shotId} was deleted, skipping final update`
          );
        }
      });
    }

    // Return the video URL and duration
    return { videoUrl, duration };
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<MotionWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): Promise<void> {
    const input = event.payload;
    const model = input.model || DEFAULT_VIDEO_MODEL;

    // Motion is always sequence-scoped (every trigger sets both ids), and the
    // dual-write needs sequenceId for the `video_variants` version — so gate on
    // both.
    if (input.shotId && input.sequenceId) {
      const { shotId, sequenceId } = input;
      await persistMotionFailure({
        scopedDb,
        shotId,
        model,
        error,
        workflowRunId: event.instanceId,
        variantOnly: input.variantOnly,
        emit: async (event2, payload) => {
          try {
            await getGenerationChannel(sequenceId).emit(event2, payload);
          } catch (emitError) {
            logger.error(
              `[MotionWorkflow:cf] Failed to emit generation.video:progress for shot ${shotId}:`,
              { err: emitError }
            );
          }
        },
      });
    }

    if (isContentRejectionError(error)) {
      logger.warn(
        `[MotionWorkflow:cf] shot ${input.shotId} failed a content checker`,
        {
          event: CONTENT_REJECTION_EVENT,
          kind: 'motion',
          model,
          shotId: input.shotId,
          sequenceId: input.sequenceId,
          error,
        }
      );
    }

    logger.error(
      `[MotionWorkflow:cf] Motion generation failed for shot ${input.shotId}: ${error}`
    );
  }
}
