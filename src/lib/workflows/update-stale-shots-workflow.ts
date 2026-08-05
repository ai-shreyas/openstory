/**
 * "Update all" (#1077/#1085) — durable server-side regeneration of the
 * out-of-date artifacts in scope (a shot, a scene, or the whole sequence),
 * at a user-chosen cascade depth (src/lib/shots/update-stale-depth.ts):
 *
 *   'prompts' → stale visual/motion prompts only, nothing renders
 *   'images'  → + stale stills, and stills whose visual prompt regenerates
 *               in this run (cascade); never a FIRST still
 *   'video'   → + existing videos whose upstream changed in this run or
 *               whose manifest already diverged; never a FIRST video
 *   'music'   → + the sequence music prompt, and the existing track behind
 *               a successful prompt regen; never a FIRST generation
 *
 * Per shot the dependency order is visual-prompt → image → video, with the
 * motion prompt alongside (video waits on it too). Chained stages never run
 * from an upstream the run failed to replace.
 *
 * Concurrency model — no locks, self-correcting via input hashes + pending
 * claims (#1085):
 *
 *   - The PLAN (which shots, which artifacts) is computed from live scoped
 *     state in the `compute-plan` step and persisted as its durable result:
 *     frozen at run start, identical across replays. Edits made mid-run
 *     can't add or remove targets — they simply produce new staleness that
 *     the indicators surface after the run. The plan holds ids and flags
 *     only; scene bodies are materialised per shot in `prepare-prompt-*` to
 *     keep the step result under CF's 1 MiB cap.
 *   - `claim-targets` pre-creates a pending version row per prompt/image
 *     artifact, so in-flight work reads 'updating' and duplicate enqueues
 *     no-op. (Video/music ride their existing status columns instead.)
 *   - Each prompt child gets its inputs snapshotted in its own
 *     `prepare-prompt-*` step (#991 — leaves never read the DB mid-run) and
 *     stamps the hash of the inputs it actually used, so a mid-run script
 *     edit leaves the new prompt honestly stale again rather than silently
 *     wrong.
 *   - A chained image consumes the prompt its OWN dependency claim produced
 *     (see `spawnImage`), so a post-click edit cannot leak into the run; the
 *     video stage then reads the freshly-completed selection pointers.
 *
 * Failures are per-shot and per-stage: one child failing (including an
 * insufficient-credits preflight) leaves that artifact out of date and
 * visible; siblings proceed, and downstream stages of the failed artifact
 * are skipped, not rendered from stale inputs.
 */

import { computeMusicPromptInputHash } from '@/lib/ai/input-hash';
import {
  DEFAULT_ANALYSIS_MODEL,
  getAnalysisModelById,
} from '@/lib/ai/models.config';
import { resolveVideoModel } from '@/lib/ai/resolve-asset-models';
import type { Scene } from '@/lib/ai/scene-analysis.schema';
import { getEffectiveFalPricing } from '@/lib/ai/fal-pricing-live';
import { estimateVideoCost, gateEstimate } from '@/lib/billing/cost-estimation';
import { requireCredits } from '@/lib/billing/preflight';
import type { ScopedDb } from '@/lib/db/scoped';
import { isInsufficientCreditsError } from '@/lib/errors';
import { buildMotionReferenceImages } from '@/lib/motion/build-motion-references';
import { resolveMotionPromptFromVersion } from '@/lib/motion/resolve-motion-prompt';
import { resolveShotDuration } from '@/lib/motion/resolve-shot-duration';
import { getAnchorImageUrl, getFrameImageUrl } from '@/lib/shots/frame-image';
import { getLogger } from '@/lib/observability/logger';
import {
  loadSceneContextBySequence,
  resolveSceneForShot,
} from '@/lib/scenes/scene-script';
import { prepareShotImageWorkflowInput } from '@/lib/shots/shot-image-input';
import {
  DEFAULT_UPDATE_STALE_DEPTH,
  type UpdateStaleDepth,
} from '@/lib/shots/update-stale-depth';
import {
  claimTargets,
  computePlan,
  type MusicPlan,
  type PlanTarget,
  type ShotClaims,
  type SkippedShot,
} from '@/lib/shots/update-stale-plan';
import { spawnAndAwaitChild } from '@/lib/workflow/await-child';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type {
  FramePromptWorkflowInput,
  ImageWorkflowInput,
  MotionPromptWorkflowInput,
  MotionWorkflowInput,
  MotionWorkflowResult,
  MusicPromptWorkflowInput,
  MusicWorkflowInput,
  UpdateStaleShotsWorkflowInput,
} from '@/lib/workflow/types';
import { buildMusicSceneSummaries } from '@/lib/workflows/music-scene-summaries';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

const logger = getLogger(['openstory', 'workflow', 'update-stale-shots']);

const PARENT_BINDING_NAME = 'UPDATE_STALE_SHOTS_WORKFLOW';

type UpdateStage =
  | 'visual-prompt'
  | 'motion-prompt'
  | 'image'
  | 'video'
  | 'music-prompt'
  | 'music';

/** `shotId` is the sequence id for the sequence-scoped music stages. */
type UpdateFailure = { shotId: string; stage: UpdateStage; error: string };

type UpdateStaleShotsResult = {
  totalShots: number;
  visualPrompts: number;
  motionPrompts: number;
  images: number;
  videos: number;
  musicPrompts: number;
  musicTracks: number;
  failures: UpdateFailure[];
  /** Shots the plan could not act on — see `SkippedShot`. */
  skipped: SkippedShot[];
};

type ImageChildOutput = { imageUrl?: string; cancelled?: boolean };

/** A prompt target's scenes, materialised per shot in `prepare-prompt-*`. */
type PromptScenes = {
  /** Script-overlaid scene metadata, the prompt children's primary input. */
  scene: Scene;
  /** Raw neighbour metadata for motion continuity. */
  sceneBefore?: Scene;
  sceneAfter?: Scene;
};

export class UpdateStaleShotsWorkflow extends OpenStoryWorkflowEntrypoint<UpdateStaleShotsWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<UpdateStaleShotsWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<UpdateStaleShotsResult> {
    const input = event.payload;
    const parentInstanceId = event.instanceId;
    const { userId, teamId, sequenceId, sceneId, shotId } = input;
    if (!sequenceId) {
      throw new WorkflowValidationError('Sequence ID is required');
    }
    // Runs enqueued before the depth picker existed carry no depth.
    const depth: UpdateStaleDepth = input.depth ?? DEFAULT_UPDATE_STALE_DEPTH;

    // ============================================================
    // PHASE 1: freeze the plan from live state (domain logic lives in
    // `@/lib/shots/update-stale-plan`). The step result is the run's
    // durable snapshot of what will regenerate / be billed.
    // ============================================================
    const plan = await step.do('compute-plan', async () => {
      try {
        return await computePlan({
          scopedDb,
          sequenceId,
          sceneId,
          shotId,
          depth,
        });
      } catch (error) {
        // Plan throws WorkflowValidationError (lib-safe); CF retries plain
        // Errors inside step.do, so re-wrap as NonRetryableError here.
        if (error instanceof WorkflowValidationError) {
          throw new NonRetryableError(error.message, error.name);
        }
        throw error;
      }
    });

    const counters = {
      visualPrompts: 0,
      motionPrompts: 0,
      images: 0,
      videos: 0,
      musicPrompts: 0,
      musicTracks: 0,
    };
    const failures: UpdateFailure[] = [];
    // Version-skew guard: a run whose `compute-plan` step was cached by a
    // pre-depth-picker deploy replays a Plan with NO `music` key at all —
    // `?? null` keeps that `undefined` from being dereferenced below.
    const planMusic = plan.music ?? null;
    const musicToRun =
      planMusic && (planMusic.regenPrompt || planMusic.regenTrack)
        ? planMusic
        : null;

    if (plan.targets.length === 0 && musicToRun === null) {
      return {
        totalShots: 0,
        ...counters,
        failures: [],
        skipped: plan.skipped,
      };
    }

    const promptCommon = plan.promptContext;
    if (plan.targets.length > 0 && !promptCommon) {
      // Targets exist but the prompt context failed to load (e.g. style
      // deleted) — nothing downstream can run.
      throw new NonRetryableError(
        'Prompt context unavailable for stale-shot update',
        'WorkflowValidationError'
      );
    }

    // ============================================================
    // PHASE 1b: claim the targets (#1085) — one pending version row per
    // artifact this run will produce. From here on the run is visible as
    // 'updating' and duplicate enqueues (second click / tab / teammate)
    // no-op server-side. (Video/music have no claim rows — their in-flight
    // state lives on video_variants.status / sequences.musicStatus, which
    // the plan already treats as "leave it alone".)
    // ============================================================
    const claimed =
      plan.targets.length > 0
        ? await step.do('claim-targets', () =>
            claimTargets({
              scopedDb,
              targets: plan.targets,
              sequenceId,
              parentInstanceId,
            })
          )
        : { claimsByShot: {}, skipped: [] };
    const allSkipped = [...plan.skipped, ...claimed.skipped];

    const spawnImage = async (
      target: PlanTarget,
      claims: ShotClaims
    ): Promise<void> => {
      // The prompt source is deterministic (#1085): a chained render consumes
      // the prompt its OWN dependency row produced — never a re-read of
      // whatever is stored at spawn time — so a post-click edit cannot leak
      // into this run (it re-stales the artifact instead). Direct renders
      // (image stale, prompt not) still read current state; their claim hash
      // self-invalidates on edit.
      // JSON round-trip at the step boundary: `ImageWorkflowInput.style` is
      // typed `Json`, which the step's Serializable constraint rejects even
      // though the value is plain JSON (same pattern as await-child.ts).
      const imageInputJson = await step.do(
        `prepare-image-${target.shotId}`,
        async (): Promise<string | null> => {
          const [shot, frame, sequence] = await Promise.all([
            scopedDb.shots.getById(target.shotId),
            scopedDb.frames.getAnchorByShot(target.shotId),
            scopedDb.sequences.getById(sequenceId),
          ]);
          if (!shot || !frame || !sequence) {
            throw new NonRetryableError(
              `Shot ${target.shotId} disappeared mid-update`,
              'WorkflowValidationError'
            );
          }
          let promptOverride: string | undefined;
          if (target.regenVisual && claims.visualVersionId) {
            const dep = await scopedDb.framePromptVersions.getByIdForFrame(
              claims.visualVersionId,
              frame.id
            );
            if (dep?.status === 'completed') {
              promptOverride = dep.text;
            } else if (frame.visualPromptInputHash === target.visualLiveHash) {
              // The claim retired in favour of an identical existing row
              // (unique-index collision path) — the intended prompt is the
              // frame's current mirror.
              promptOverride = frame.imagePrompt ?? undefined;
            } else {
              // The upstream prompt didn't land for this run: the user
              // cancelled it, or a post-click edit superseded the mirror.
              // Never render from it — but this is a stand-down, not a run
              // failure (#1095 review). Release the image claim and skip.
              if (claims.imageVariantId) {
                await scopedDb.frameVariants.markTerminal(
                  claims.imageVariantId,
                  'cancelled',
                  'Upstream visual prompt was cancelled or superseded by a newer edit'
                );
              }
              return null;
            }
          }
          const scriptBySceneId = await loadSceneContextBySequence(
            scopedDb,
            sequenceId
          );
          const { scene, script } = resolveSceneForShot(shot, scriptBySceneId);
          try {
            const prepared = await prepareShotImageWorkflowInput({
              scopedDb,
              sequence,
              shot,
              frame,
              scene,
              scriptExtract:
                script?.extract ?? scene?.originalScript.extract ?? '',
              userId,
              promptOverride,
            });
            return JSON.stringify({
              ...prepared,
              targetVariantId: claims.imageVariantId ?? undefined,
            });
          } catch (error) {
            // Running out of credits is terminal, not transient: retrying
            // burns the step's whole budget on a call that cannot succeed and
            // keeps the run "in flight" long past the point the user could be
            // told why nothing is happening.
            if (isInsufficientCreditsError(error)) {
              throw new NonRetryableError(
                error instanceof Error ? error.message : String(error),
                'InsufficientCreditsError'
              );
            }
            throw error;
          }
        }
      );
      if (imageInputJson === null) {
        // Upstream prompt cancelled/superseded — stood down in prepare.
        logger.info(
          `[UpdateStaleShotsWorkflow] image for shot ${target.shotId} stood down (upstream prompt cancelled or superseded)`
        );
        return;
      }
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the step above serialized exactly this type
      const imageInput = JSON.parse(imageInputJson) as ImageWorkflowInput;
      const output = await spawnAndAwaitChild<
        ImageWorkflowInput,
        ImageChildOutput
      >(step, {
        binding: this.env.IMAGE_WORKFLOW,
        parentBindingName: PARENT_BINDING_NAME,
        parentInstanceId,
        childId: `image:${sequenceId}:${target.shotId}`,
        childPayload: imageInput,
        spawnStepName: `spawn-image-${target.shotId}`,
        awaitStepName: `await-image-${target.shotId}`,
      });
      // A user cancel (before or during the render) is a stand-down, not a
      // failure — and definitely not a render to count (#1095 review).
      if (output.cancelled) {
        logger.info(
          `[UpdateStaleShotsWorkflow] image for shot ${target.shotId} was cancelled by the user; not counted`
        );
        return;
      }
      // ImageWorkflow has a success path that renders nothing — it returns an
      // empty `imageUrl` when its anchor frame vanished mid-run. Counting that
      // as a render would report work the user never got.
      if (!output.imageUrl) {
        throw new Error('Image workflow completed without producing an image');
      }
      counters.images += 1;
    };

    /**
     * Re-render a shot's video (depth ≥ 'video', #1085). The prepare step
     * resolves everything from CURRENT state — by design AFTER this run's
     * motion-prompt and image stages have landed, so the render consumes the
     * freshly regenerated prompt (via the selection pointer completion just
     * repointed) and the fresh still. Mirrors `generateShotMotionFn`'s
     * resolution: selected motion version → assembled prompt, video model
     * from selected version → sequence default, #873 reference images,
     * model-snapped duration, credits preflight.
     */
    const spawnVideo = async (target: PlanTarget): Promise<void> => {
      const motionInputJson = await step.do(
        `prepare-video-${target.shotId}`,
        async (): Promise<string | null> => {
          const [shot, frame, sequence] = await Promise.all([
            scopedDb.shots.getById(target.shotId),
            scopedDb.frames.getAnchorByShot(target.shotId),
            scopedDb.sequences.getById(sequenceId),
          ]);
          if (!shot || !frame || !sequence) {
            throw new NonRetryableError(
              `Shot ${target.shotId} disappeared mid-update`,
              'WorkflowValidationError'
            );
          }
          // The still lives on the anchor's selected version (#1067).
          const stillUrl = await getFrameImageUrl(scopedDb, frame.id);
          if (!stillUrl) {
            throw new NonRetryableError(
              `Shot ${target.shotId} has no rendered still to animate`,
              'WorkflowValidationError'
            );
          }

          const [
            selectedMotion,
            selectedVideo,
            characters,
            elements,
            sceneContext,
          ] = await Promise.all([
            scopedDb.shotPromptVersions.getSelectedMotion(shot.id),
            scopedDb.videoVariants.getSelectedByShot(shot.id),
            scopedDb.characters.listWithSheets(sequenceId),
            scopedDb.sequenceElements.list(sequenceId),
            loadSceneContextBySequence(scopedDb, sequenceId),
          ]);
          const { scene } = resolveSceneForShot(shot, sceneContext);

          // Spawn-time re-check (billing safety): the plan's video gating ran
          // at run START, possibly many minutes ago, and video has no claim
          // rows — a concurrent Update all (second tab, teammate) or a manual
          // render could have started or finished this exact work meanwhile.
          // Re-evaluate against CURRENT state and skip quietly (null): if a
          // render is in flight, it is already producing the fix; if the
          // selected manifest again matches the live pointers, someone
          // already rendered from the fresh inputs; if the selection vanished
          // there is no video to update (never a FIRST render).
          if (!selectedVideo) return null;
          if (shot.renderSegmentId) {
            const segmentVersions = await scopedDb.videoVariants.listBySegment(
              shot.renderSegmentId
            );
            if (segmentVersions.some((v) => v.status === 'generating')) {
              return null;
            }
          }
          const manifestEntry = selectedVideo.manifest.find(
            (entry) => entry.shotId === shot.id
          );
          const diverged =
            !manifestEntry ||
            manifestEntry.motionPromptVersionId !==
              shot.selectedMotionPromptVersionId ||
            manifestEntry.frameVersionId !== frame.selectedImageVersionId;
          if (!diverged) return null;
          // Selected-version model → sequence default. (The single-shot fn
          // also consults a last-failed attempt; irrelevant here — a video
          // must already exist for this target to be planned.)
          const model = resolveVideoModel({
            selectedVersionModel: selectedVideo.model,
            sequenceModel: sequence.videoModel,
          });
          const prompt = resolveMotionPromptFromVersion(
            selectedMotion,
            {
              characterTags: scene?.continuity?.characterTags,
              description: scene?.originalScript.extract ?? null,
            },
            model
          );
          if (!prompt) {
            throw new NonRetryableError(
              `Shot ${target.shotId} has no motion prompt to render from`,
              'WorkflowValidationError'
            );
          }
          const referenceImages = buildMotionReferenceImages({
            scene,
            characters,
            elements,
          });
          const duration = resolveShotDuration({
            durationMs: shot.durationMs,
            model,
          });
          try {
            await requireCredits(
              scopedDb,
              gateEstimate(
                estimateVideoCost(model, duration, {
                  pricing: await getEffectiveFalPricing(),
                }),
                { model, operation: 'update-stale-shots:video' }
              ),
              {
                errorMessage: 'Insufficient credits for video generation',
              }
            );
          } catch (error) {
            if (isInsufficientCreditsError(error)) {
              throw new NonRetryableError(
                error instanceof Error ? error.message : String(error),
                'InsufficientCreditsError'
              );
            }
            throw error;
          }
          const motionInput: MotionWorkflowInput = {
            userId,
            teamId,
            sequenceId,
            shotId: shot.id,
            imageUrl: stillUrl,
            prompt,
            model,
            duration,
            aspectRatio: sequence.aspectRatio,
            referenceImages,
          };
          return JSON.stringify(motionInput);
        }
      );
      if (motionInputJson === null) {
        logger.info(
          `[UpdateStaleShotsWorkflow] video for shot ${target.shotId} no longer needs rendering; skipping`
        );
        return;
      }
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the step above serialized exactly this type
      const motionInput = JSON.parse(motionInputJson) as MotionWorkflowInput;
      await spawnAndAwaitChild<MotionWorkflowInput, MotionWorkflowResult>(
        step,
        {
          binding: this.env.MOTION_WORKFLOW,
          parentBindingName: PARENT_BINDING_NAME,
          parentInstanceId,
          childId: `motion:${sequenceId}:${target.shotId}`,
          childPayload: motionInput,
          spawnStepName: `spawn-video-${target.shotId}`,
          awaitStepName: `await-video-${target.shotId}`,
        }
      );
      counters.videos += 1;
    };

    /**
     * Materialise a prompt target's scenes. Kept out of the plan (see
     * `PlanTarget`) so the plan stays under the 1 MiB step-result cap; one
     * step per shot means each result carries a single shot's scenes.
     * Neighbours resolve through the same scene context, matching
     * regenerateShotPromptFn.
     */
    const loadPromptScenes = (target: PlanTarget): Promise<PromptScenes> =>
      step.do(`prepare-prompt-${target.shotId}`, async () => {
        const [shot, scriptBySceneId] = await Promise.all([
          scopedDb.shots.getById(target.shotId),
          loadSceneContextBySequence(scopedDb, sequenceId),
        ]);
        if (!shot) {
          throw new NonRetryableError(
            `Shot ${target.shotId} disappeared mid-update`,
            'WorkflowValidationError'
          );
        }
        const { scene } = resolveSceneForShot(shot, scriptBySceneId);
        if (!scene) {
          throw new NonRetryableError(
            `Shot ${target.shotId} lost its scene metadata mid-update`,
            'WorkflowValidationError'
          );
        }
        const neighbourIds = [target.beforeShotId, target.afterShotId].filter(
          (id): id is string => id !== null
        );
        const neighbours = await Promise.all(
          neighbourIds.map((id) => scopedDb.shots.getById(id))
        );
        const sceneById = new Map(
          neighbours
            .filter((s) => !!s)
            .map((s) => [
              s.id,
              resolveSceneForShot(s, scriptBySceneId).scene ?? undefined,
            ])
        );
        return {
          scene,
          sceneBefore: target.beforeShotId
            ? sceneById.get(target.beforeShotId)
            : undefined,
          sceneAfter: target.afterShotId
            ? sceneById.get(target.afterShotId)
            : undefined,
        };
      });

    // ============================================================
    // PHASE 2: fan out — one job per shot, so a shot's scene step runs once
    // for both its prompt children. Within a shot the visual-prompt → image
    // chain is sequential while the motion prompt runs alongside, and the
    // video render (depth ≥ 'video') waits on both. Failures are recorded
    // per stage so one shot never blocks its peers.
    // ============================================================
    // `promptCommon` is provably non-null whenever targets exist (the guard
    // above throws otherwise); the ternary is for the compiler, and yields
    // the same empty job list a target-less (music-only) run needs.
    const jobs = !promptCommon
      ? []
      : plan.targets.map((target) =>
          (async (): Promise<void> => {
            const claims = claimed.claimsByShot[target.shotId] ?? {
              visualVersionId: null,
              motionVersionId: null,
              imageVariantId: null,
            };
            // A regen flag without a claim means another run already owns that
            // artifact ('already-in-flight' in `skipped`) — this run stands down.
            const doVisual =
              target.regenVisual && claims.visualVersionId !== null;
            const doMotion =
              target.regenMotion && claims.motionVersionId !== null;
            const doImage = target.regenImage && claims.imageVariantId !== null;

            // Best-effort claim cleanup on a stage failure — a claim must never
            // outlive its run's ability to complete it (the reconciler is the
            // backstop for anything this misses).
            const failClaims = async (stage: UpdateStage): Promise<void> => {
              try {
                if (stage === 'visual-prompt' && claims.visualVersionId) {
                  await scopedDb.framePromptVersions.markTerminal(
                    claims.visualVersionId,
                    'failed'
                  );
                  await scopedDb.frameVariants.cancelByDependency(
                    claims.visualVersionId,
                    'Upstream visual prompt generation failed'
                  );
                }
                if (stage === 'motion-prompt' && claims.motionVersionId) {
                  await scopedDb.shotPromptVersions.markTerminal(
                    claims.motionVersionId,
                    'failed'
                  );
                }
                if (stage === 'image' && claims.imageVariantId) {
                  await scopedDb.frameVariants.markTerminal(
                    claims.imageVariantId,
                    'failed',
                    'Image stage failed in Update all'
                  );
                }
              } catch (err) {
                logger.warn(
                  `[UpdateStaleShotsWorkflow] failed to clean up claim for shot ${target.shotId}`,
                  { err }
                );
              }
            };

            const needsPrompt = doVisual || doMotion;
            let scenes: PromptScenes | null = null;
            if (needsPrompt) {
              try {
                scenes = await loadPromptScenes(target);
              } catch (error) {
                // Both prompt stages depend on this; neither can proceed.
                if (doVisual) {
                  failures.push(
                    toFailure(target.shotId, 'visual-prompt', error)
                  );
                  await failClaims('visual-prompt');
                }
                if (doMotion) {
                  failures.push(
                    toFailure(target.shotId, 'motion-prompt', error)
                  );
                  await failClaims('motion-prompt');
                }
                if (doImage) await failClaims('image');
                if (target.regenVideo) {
                  failures.push({
                    shotId: target.shotId,
                    stage: 'video',
                    error:
                      'Upstream regeneration failed — video not re-rendered',
                  });
                }
                return;
              }
            }

            // Video ordering (#1085 depth ≥ 'video'): the render consumes the
            // regenerated motion prompt AND the regenerated still, so it waits on
            // BOTH stages and only runs when every upstream it depends on landed.
            // Vacuously true for stages this run isn't regenerating.
            const upstream = { motionOk: true, imageOk: true };

            const base = scenes && {
              userId,
              teamId,
              sequenceId,
              shotId: target.shotId,
              scene: scenes.scene,
              aspectRatio: plan.aspectRatio,
              ...promptCommon,
              // The user just clicked Update all, so a mounted shot panel should
              // see its prompt stream in — same as the single-shot regen path.
              emitStreaming: true,
            };

            const stages: Array<Promise<void>> = [];

            // The motion prompt is conditioned on the rendered still (#929),
            // so when this run ALSO regenerates the image it must run after
            // the image chain and read the fresh still — racing them stamps a
            // hash the new still immediately invalidates, and the artifact
            // reads stale again the moment the run finishes (#1095 review).
            const runMotionPrompt = async (): Promise<void> => {
              if (!(doMotion && base && scenes)) return;
              let startingFrameImageUrl = target.startingFrameImageUrl;
              if (doImage) {
                startingFrameImageUrl = await step.do(
                  `refresh-still-${target.shotId}`,
                  async () => {
                    return (
                      (await getAnchorImageUrl(scopedDb, target.shotId)) ??
                      target.startingFrameImageUrl ??
                      null
                    );
                  }
                );
              }
              try {
                await spawnAndAwaitChild<MotionPromptWorkflowInput, unknown>(
                  step,
                  {
                    binding: this.env.MOTION_PROMPT_WORKFLOW,
                    parentBindingName: PARENT_BINDING_NAME,
                    parentInstanceId,
                    childId: `motion-prompt:${sequenceId}:${target.shotId}`,
                    childPayload: {
                      ...base,
                      sceneBefore: scenes.sceneBefore,
                      sceneAfter: scenes.sceneAfter,
                      startingFrameImageUrl: startingFrameImageUrl ?? undefined,
                      targetVersionId: claims.motionVersionId ?? undefined,
                    },
                    spawnStepName: `spawn-motion-prompt-${target.shotId}`,
                    awaitStepName: `await-motion-prompt-${target.shotId}`,
                  }
                );
                counters.motionPrompts += 1;
              } catch (error) {
                upstream.motionOk = false;
                failures.push(toFailure(target.shotId, 'motion-prompt', error));
                await failClaims('motion-prompt');
              }
            };

            if (!doImage) {
              // No image regen — the still can't move, run alongside.
              stages.push(runMotionPrompt());
            }

            if (doVisual && base) {
              stages.push(
                (async () => {
                  try {
                    await spawnAndAwaitChild<FramePromptWorkflowInput, unknown>(
                      step,
                      {
                        binding: this.env.FRAME_PROMPT_WORKFLOW,
                        parentBindingName: PARENT_BINDING_NAME,
                        parentInstanceId,
                        childId: `frame-prompt:${sequenceId}:${target.shotId}`,
                        childPayload: {
                          ...base,
                          frameId: target.frameId,
                          targetVersionId: claims.visualVersionId ?? undefined,
                        },
                        spawnStepName: `spawn-frame-prompt-${target.shotId}`,
                        awaitStepName: `await-frame-prompt-${target.shotId}`,
                      }
                    );
                    counters.visualPrompts += 1;
                  } catch (error) {
                    // Never render from the prompt the regen failed to replace.
                    upstream.imageOk = false;
                    failures.push(
                      toFailure(target.shotId, 'visual-prompt', error)
                    );
                    await failClaims('visual-prompt');
                    // The chained image claim was cancelled by the cascade
                    // above. The motion prompt still runs — the still didn't
                    // change, so its claim hash remains valid.
                    if (doImage) await runMotionPrompt();
                    return;
                  }
                  if (!doImage) return;
                  try {
                    await spawnImage(target, claims);
                  } catch (error) {
                    upstream.imageOk = false;
                    failures.push(toFailure(target.shotId, 'image', error));
                    await failClaims('image');
                  }
                  // After the image settles either way: fresh still on
                  // success, unchanged still on failure — both are safe
                  // inputs for the motion prompt.
                  await runMotionPrompt();
                })()
              );
            } else if (doImage) {
              stages.push(
                (async () => {
                  try {
                    await spawnImage(target, claims);
                  } catch (error) {
                    upstream.imageOk = false;
                    failures.push(toFailure(target.shotId, 'image', error));
                    await failClaims('image');
                  }
                  await runMotionPrompt();
                })()
              );
            }

            await Promise.allSettled(stages);

            if (target.regenVideo) {
              if (upstream.motionOk && upstream.imageOk) {
                try {
                  await spawnVideo(target);
                } catch (error) {
                  failures.push(toFailure(target.shotId, 'video', error));
                }
              } else {
                // Rendering from the prompt/still the run failed to replace would
                // bill for a video the user didn't ask for.
                failures.push({
                  shotId: target.shotId,
                  stage: 'video',
                  error: 'Upstream regeneration failed — video not re-rendered',
                });
              }
            }
          })()
        );

    // ============================================================
    // PHASE 3 (depth 'music', #1085): sequence-level music, alongside the
    // shot jobs. Prompt first; the track cascades only behind a successful
    // prompt regeneration (see MusicPlan).
    // ============================================================
    const musicJob = musicToRun
      ? (async (music: MusicPlan): Promise<void> => {
          if (music.regenPrompt) {
            try {
              const musicPromptInputJson = await step.do(
                'prepare-music-prompt',
                async (): Promise<string | null> => {
                  const [sequence, shots, sceneContext] = await Promise.all([
                    scopedDb.sequences.getById(sequenceId),
                    scopedDb.shots.listBySequence(sequenceId),
                    loadSceneContextBySequence(scopedDb, sequenceId),
                  ]);
                  if (!sequence) {
                    throw new NonRetryableError(
                      `Sequence ${sequenceId} disappeared mid-update`,
                      'WorkflowValidationError'
                    );
                  }
                  const sceneSummaries = buildMusicSceneSummaries(
                    shots
                      .map((s) => resolveSceneForShot(s, sceneContext).scene)
                      .filter((s): s is NonNullable<typeof s> => s !== null)
                  );
                  const analysisModelId =
                    getAnalysisModelById(sequence.analysisModel)?.id ??
                    DEFAULT_ANALYSIS_MODEL;
                  // Spawn-time re-check (no claim rows for music): if the
                  // stored hash caught up with live meanwhile, a concurrent
                  // run or manual regenerate already produced this prompt —
                  // skip quietly, and let that run own the track cascade.
                  const liveHash = await computeMusicPromptInputHash({
                    sceneSummaries,
                    analysisModel: analysisModelId,
                  });
                  if (liveHash === sequence.musicPromptInputHash) return null;
                  const payload: MusicPromptWorkflowInput = {
                    userId,
                    teamId,
                    sequenceId,
                    sceneSummaries,
                    analysisModelId,
                  };
                  return JSON.stringify(payload);
                }
              );
              if (musicPromptInputJson === null) {
                logger.info(
                  `[UpdateStaleShotsWorkflow] music prompt for ${sequenceId} already regenerated elsewhere; skipping`
                );
                return;
              }
              await spawnAndAwaitChild<MusicPromptWorkflowInput, unknown>(
                step,
                {
                  binding: this.env.MUSIC_PROMPT_WORKFLOW,
                  parentBindingName: PARENT_BINDING_NAME,
                  parentInstanceId,
                  childId: `music-prompt:${sequenceId}`,
                  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the step above serialized exactly this type
                  childPayload: JSON.parse(
                    musicPromptInputJson
                  ) as MusicPromptWorkflowInput,
                  spawnStepName: 'spawn-music-prompt',
                  awaitStepName: 'await-music-prompt',
                }
              );
              counters.musicPrompts += 1;
            } catch (error) {
              failures.push(toFailure(sequenceId, 'music-prompt', error));
              if (music.regenTrack) {
                // Never regenerate the track from the prompt the run
                // failed to replace.
                failures.push({
                  shotId: sequenceId,
                  stage: 'music',
                  error: 'Upstream music prompt failed — track not regenerated',
                });
              }
              return;
            }
          }

          if (!music.regenTrack) return;
          try {
            const musicInputJson = await step.do(
              'prepare-music-track',
              async (): Promise<string | null> => {
                // Read AFTER the prompt child landed: its completion
                // mirrored the fresh prompt/tags onto the sequence.
                const [sequence, shots] = await Promise.all([
                  scopedDb.sequences.getById(sequenceId),
                  scopedDb.shots.listBySequence(sequenceId),
                ]);
                if (!sequence?.musicPrompt) {
                  throw new NonRetryableError(
                    'Sequence has no music prompt to regenerate from',
                    'WorkflowValidationError'
                  );
                }
                // Spawn-time re-check: a concurrent run or manual
                // regenerate already has a track render in flight — it is
                // producing the fix, don't double-bill.
                if (sequence.musicStatus === 'generating') return null;
                // Same duration rule as generateMusicFn: shot durations
                // with the 30s empty floor. Model stays the workflow
                // default — parity with the manual regenerate path.
                const durationSeconds =
                  Math.round(
                    shots.reduce(
                      (sum, s) =>
                        sum + (s.durationMs ? s.durationMs / 1000 : 10),
                      0
                    )
                  ) || 30;
                const payload: MusicWorkflowInput = {
                  userId,
                  teamId,
                  sequenceId,
                  prompt: sequence.musicPrompt,
                  tags: sequence.musicTags ?? '',
                  duration: durationSeconds,
                  isPrimary: true,
                };
                return JSON.stringify(payload);
              }
            );
            if (musicInputJson === null) {
              logger.info(
                `[UpdateStaleShotsWorkflow] music track for ${sequenceId} already rendering elsewhere; skipping`
              );
              return;
            }
            await spawnAndAwaitChild<MusicWorkflowInput, unknown>(step, {
              binding: this.env.MUSIC_WORKFLOW,
              parentBindingName: PARENT_BINDING_NAME,
              parentInstanceId,
              childId: `music:${sequenceId}`,
              // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the step above serialized exactly this type
              childPayload: JSON.parse(musicInputJson) as MusicWorkflowInput,
              spawnStepName: 'spawn-music-track',
              awaitStepName: 'await-music-track',
            });
            counters.musicTracks += 1;
          } catch (error) {
            failures.push(toFailure(sequenceId, 'music', error));
          }
        })(musicToRun)
      : null;

    await Promise.allSettled(musicJob ? [...jobs, musicJob] : jobs);

    // A user-initiated action that partly failed is a production issue, not a
    // warning — `error` is the only severity that surfaces in error tracking.
    if (failures.length > 0) {
      logger.error(
        `[UpdateStaleShotsWorkflow] ${failures.length} stage failure(s) across ${plan.targets.length} shots`,
        { failures }
      );
    }
    if (allSkipped.length > 0) {
      logger.error(
        `[UpdateStaleShotsWorkflow] ${allSkipped.length} shot(s) skipped by the plan`,
        { skipped: allSkipped }
      );
    }

    return {
      totalShots: plan.targets.length,
      ...counters,
      failures,
      skipped: allSkipped,
    };
  }
}

function toFailure(
  shotId: string,
  stage: UpdateStage,
  error: unknown
): UpdateFailure {
  return {
    shotId,
    stage,
    error: error instanceof Error ? error.message : String(error),
  };
}
