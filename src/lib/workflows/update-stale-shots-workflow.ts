/**
 * "Update all" (#1077) — durable server-side regeneration of every artifact
 * in scope (a shot, a scene, or the whole sequence) that reads stale *right
 * now*. One artifact per stale flag, no cascade: regenerating a visual prompt
 * outdates the shot's image, but that image is only re-rendered if it was
 * already stale itself. The user sees the new staleness afterwards and can
 * run Update all again. (Cascading is deliberately deferred to a later issue.)
 *
 * Per shot:
 *
 *   visual prompt stale → FramePromptWorkflow child
 *   motion prompt stale → MotionPromptWorkflow child   (no auto video render)
 *   image stale         → ImageWorkflow child
 *
 * When both the visual prompt and the image are independently stale, the
 * image waits on the prompt — that is dependency ordering, not a cascade;
 * rendering in parallel would burn credits on the prompt we're replacing.
 *
 * Concurrency model — no locks, self-correcting via input hashes:
 *
 *   - The PLAN (which shots, which artifacts) is computed from live scoped
 *     state in the `compute-plan` step and persisted as its durable result:
 *     frozen at run start, identical across replays. Edits made mid-run
 *     can't add or remove targets — they simply produce new staleness that
 *     the indicators surface after the run. The plan holds ids and flags
 *     only; scene bodies are materialised per shot in `prepare-prompt-*` to
 *     keep the step result under CF's 1 MiB cap.
 *   - Each prompt child gets its inputs snapshotted in its own
 *     `prepare-prompt-*` step (#991 — leaves never read the DB mid-run) and
 *     stamps the hash of the inputs it actually used, so a mid-run script
 *     edit leaves the new prompt honestly stale again rather than silently
 *     wrong.
 *   - The image step deliberately re-reads CURRENT state after its prompt
 *     child completes (`prepare-image-*`): if the user hand-edited the
 *     prompt in the gap, the render uses their newer text (last-write-wins
 *     on intent) and stamps its hash accordingly.
 *
 * Failures are per-shot: one child failing (including an insufficient-credits
 * preflight on an image) leaves that artifact stale and visible; siblings
 * proceed.
 */

import {
  DEFAULT_ANALYSIS_MODEL,
  getAnalysisModelById,
} from '@/lib/ai/models.config';
import { DEFAULT_IMAGE_MODEL, safeTextToImageModel } from '@/lib/ai/models';
import { loadShotPromptContext } from '@/lib/ai/prompt-context';
import type { Scene } from '@/lib/ai/scene-analysis.schema';
import type { ScopedDb } from '@/lib/db/scoped';
import {
  loadSelectedScriptsBySequence,
  resolveSceneForShot,
} from '@/lib/scenes/scene-script';
import { prepareShotImageWorkflowInput } from '@/lib/shots/shot-image-input';
import {
  computeShotStaleness,
  type ShotStalenessRefs,
} from '@/lib/shots/shot-staleness';
import { isInsufficientCreditsError } from '@/lib/errors';
import { spawnAndAwaitChild } from '@/lib/workflow/await-child';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type {
  FramePromptWorkflowInput,
  ImageWorkflowInput,
  MotionPromptWorkflowInput,
  UpdateStaleShotsWorkflowInput,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'update-stale-shots']);

const PARENT_BINDING_NAME = 'UPDATE_STALE_SHOTS_WORKFLOW';

type UpdateStage = 'visual-prompt' | 'motion-prompt' | 'image';

type UpdateFailure = { shotId: string; stage: UpdateStage; error: string };

type UpdateStaleShotsResult = {
  totalShots: number;
  visualPrompts: number;
  motionPrompts: number;
  images: number;
  failures: UpdateFailure[];
  /** Shots the plan could not act on — see `SkippedShot`. */
  skipped: SkippedShot[];
};

/**
 * One shot's frozen slice of the plan.
 *
 * Deliberately holds only ids and flags — no `Scene` objects. The whole plan
 * is persisted as one `step.do` result, which Cloudflare caps at 1 MiB
 * (docs/investigations/cloudflare-workflows.md). A sequence-scope run right
 * after a style edit is the worst case: every shot stale, and inlining each
 * target's scene plus two neighbour scenes blew the cap and killed the run at
 * its first step. Scenes are materialised per shot in `prepare-prompt-*`
 * instead. The invariant the plan exists to protect — the frozen *target
 * set*, immune to mid-run edits adding or removing work — is unchanged.
 */
type PlanTarget = {
  shotId: string;
  frameId: string;
  /**
   * Neighbour shot ids for motion continuity, resolved to raw metadata at
   * spawn time (parity with regenerateShotPromptFn). Null when not a motion
   * target, or at the ends of the sequence.
   */
  beforeShotId: string | null;
  afterShotId: string | null;
  startingFrameImageUrl: string | null;
  regenVisual: boolean;
  regenMotion: boolean;
  /**
   * The image itself read stale. Rendered directly, or chained after the
   * visual prompt when that is stale too. Never true for shots without a
   * rendered image — Update all must not spend credits creating a first
   * still.
   */
  regenImage: boolean;
  /**
   * Live input hashes captured at plan time (#1085) — stamped onto the
   * pending claim rows in `claim-targets` so in-flight work reads as
   * 'updating' and duplicate enqueues no-op. Non-null whenever the matching
   * regen flag is set.
   */
  visualLiveHash: string | null;
  motionLiveHash: string | null;
  imageLiveHash: string | null;
  /** Model to stamp on the image claim row; the render's own resolution in
   * `prepare-image-*` overwrites it via `claimForGeneration`. */
  imageModel: string;
};

/**
 * The pending rows claimed for one shot (#1085). A null slot for a set regen
 * flag means another run already holds a live claim for that artifact — this
 * run skips it rather than double-generating.
 */
type ShotClaims = {
  visualVersionId: string | null;
  motionVersionId: string | null;
  imageVariantId: string | null;
};

/**
 * A shot the plan could not act on. Distinct from a `UpdateFailure`: nothing
 * was attempted. Reported so a run that quietly covered less than the user
 * asked for can't read as a clean success.
 */
type SkippedShot = {
  shotId: string;
  reason:
    | 'no-anchor-frame'
    | 'no-scene'
    | 'staleness-unknown'
    | 'already-in-flight';
};

type Plan = {
  aspectRatio: FramePromptWorkflowInput['aspectRatio'];
  promptContext: {
    characterBible: FramePromptWorkflowInput['characterBible'];
    locationBible: FramePromptWorkflowInput['locationBible'];
    elementBible: FramePromptWorkflowInput['elementBible'];
    styleConfig: FramePromptWorkflowInput['styleConfig'];
    analysisModelId: FramePromptWorkflowInput['analysisModelId'];
  } | null;
  targets: PlanTarget[];
  skipped: SkippedShot[];
};

type ImageChildOutput = { imageUrl?: string };

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

    // ============================================================
    // PHASE 1: compute the plan from live state. The step result is
    // durably persisted — this is the run's frozen snapshot.
    // ============================================================
    const plan = await step.do('compute-plan', () =>
      computePlan({ scopedDb, sequenceId, sceneId, shotId })
    );

    if (plan.targets.length === 0) {
      return {
        totalShots: 0,
        visualPrompts: 0,
        motionPrompts: 0,
        images: 0,
        failures: [],
        skipped: plan.skipped,
      };
    }

    const counters = { visualPrompts: 0, motionPrompts: 0, images: 0 };
    const failures: UpdateFailure[] = [];
    const promptCommon = plan.promptContext;
    if (!promptCommon) {
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
    // no-op server-side.
    // ============================================================
    const claimed = await step.do('claim-targets', () =>
      claimTargets({
        scopedDb,
        targets: plan.targets,
        sequenceId,
        parentInstanceId,
      })
    );
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
        async () => {
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
              // Cancelled / failed upstream: never render from the prompt
              // the run failed to produce.
              throw new NonRetryableError(
                `Upstream visual prompt for shot ${target.shotId} was cancelled`,
                'WorkflowValidationError'
              );
            }
          }
          const scriptBySceneId = await loadSelectedScriptsBySequence(
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
      // ImageWorkflow has a success path that renders nothing — it returns an
      // empty `imageUrl` when its anchor frame vanished mid-run. Counting that
      // as a render would report work the user never got.
      if (!output.imageUrl) {
        throw new Error('Image workflow completed without producing an image');
      }
      counters.images += 1;
    };

    /**
     * Materialise a prompt target's scenes. Kept out of the plan (see
     * `PlanTarget`) so the plan stays under the 1 MiB step-result cap; one
     * step per shot means each result carries a single shot's scenes.
     * Neighbours are raw `shot.metadata`, matching regenerateShotPromptFn.
     */
    const loadPromptScenes = (target: PlanTarget): Promise<PromptScenes> =>
      step.do(`prepare-prompt-${target.shotId}`, async () => {
        const [shot, scriptBySceneId] = await Promise.all([
          scopedDb.shots.getById(target.shotId),
          loadSelectedScriptsBySequence(scopedDb, sequenceId),
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
        const byId = new Map(
          neighbours.filter((s) => !!s).map((s) => [s.id, s])
        );
        return {
          scene,
          sceneBefore: target.beforeShotId
            ? (byId.get(target.beforeShotId)?.metadata ?? undefined)
            : undefined,
          sceneAfter: target.afterShotId
            ? (byId.get(target.afterShotId)?.metadata ?? undefined)
            : undefined,
        };
      });

    // ============================================================
    // PHASE 2: fan out — one job per shot, so a shot's scene step runs once
    // for both its prompt children. Within a shot the visual-prompt → image
    // chain is sequential while the motion prompt runs alongside. Failures
    // are recorded per stage so one shot never blocks its peers.
    // ============================================================
    const jobs = plan.targets.map((target) =>
      (async (): Promise<void> => {
        const claims = claimed.claimsByShot[target.shotId] ?? {
          visualVersionId: null,
          motionVersionId: null,
          imageVariantId: null,
        };
        // A regen flag without a claim means another run already owns that
        // artifact ('already-in-flight' in `skipped`) — this run stands down.
        const doVisual = target.regenVisual && claims.visualVersionId !== null;
        const doMotion = target.regenMotion && claims.motionVersionId !== null;
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
              failures.push(toFailure(target.shotId, 'visual-prompt', error));
              await failClaims('visual-prompt');
            }
            if (doMotion) {
              failures.push(toFailure(target.shotId, 'motion-prompt', error));
              await failClaims('motion-prompt');
            }
            if (doImage) await failClaims('image');
            return;
          }
        }

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

        if (doMotion && base && scenes) {
          stages.push(
            spawnAndAwaitChild<MotionPromptWorkflowInput, unknown>(step, {
              binding: this.env.MOTION_PROMPT_WORKFLOW,
              parentBindingName: PARENT_BINDING_NAME,
              parentInstanceId,
              childId: `motion-prompt:${sequenceId}:${target.shotId}`,
              childPayload: {
                ...base,
                sceneBefore: scenes.sceneBefore,
                sceneAfter: scenes.sceneAfter,
                startingFrameImageUrl: target.startingFrameImageUrl,
                targetVersionId: claims.motionVersionId ?? undefined,
              },
              spawnStepName: `spawn-motion-prompt-${target.shotId}`,
              awaitStepName: `await-motion-prompt-${target.shotId}`,
            }).then(
              () => {
                counters.motionPrompts += 1;
              },
              async (error: unknown) => {
                failures.push(toFailure(target.shotId, 'motion-prompt', error));
                await failClaims('motion-prompt');
              }
            )
          );
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
                failures.push(toFailure(target.shotId, 'visual-prompt', error));
                await failClaims('visual-prompt');
                // The chained image claim was cancelled by the cascade above.
                return;
              }
              if (!doImage) return;
              try {
                await spawnImage(target, claims);
              } catch (error) {
                failures.push(toFailure(target.shotId, 'image', error));
                await failClaims('image');
              }
            })()
          );
        } else if (doImage) {
          stages.push(
            spawnImage(target, claims).catch(async (error: unknown) => {
              failures.push(toFailure(target.shotId, 'image', error));
              await failClaims('image');
            })
          );
        }

        await Promise.allSettled(stages);
      })()
    );
    await Promise.allSettled(jobs);

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

/**
 * Recompute staleness for the in-scope shots from live state and freeze the
 * regeneration plan. Runs inside `step.do('compute-plan')`, so the returned
 * value is the run's durable snapshot. Exported for testing — the gating
 * rules here decide what gets regenerated and therefore what gets billed.
 */
export async function computePlan(args: {
  scopedDb: ScopedDb;
  sequenceId: string;
  sceneId?: string;
  shotId?: string;
}): Promise<Plan> {
  const { scopedDb, sequenceId, sceneId, shotId } = args;
  const sequence = await scopedDb.sequences.getById(sequenceId);
  if (!sequence) {
    throw new NonRetryableError(
      `Sequence ${sequenceId} not found`,
      'WorkflowValidationError'
    );
  }

  const allShots = await scopedDb.shots.listBySequence(sequenceId);
  const inScope = allShots.filter((shot) => {
    if (shotId) return shot.id === shotId;
    if (sceneId) return shot.sceneId === sceneId;
    return true;
  });
  const skipped: SkippedShot[] = [];
  const planBase: Plan = {
    aspectRatio: sequence.aspectRatio,
    promptContext: null,
    targets: [],
    skipped,
  };
  if (inScope.length === 0) return planBase;

  await scopedDb.shots.ensureAnchorFrames(inScope);
  const [anchorRows, scriptBySceneId, characters, locations, elements] =
    await Promise.all([
      scopedDb.frames.listAnchorsBySequence(sequenceId),
      loadSelectedScriptsBySequence(scopedDb, sequenceId),
      scopedDb.characters.listWithSheets(sequenceId),
      scopedDb.sequenceLocations.listWithReferences(sequenceId),
      scopedDb.sequenceElements.list(sequenceId),
    ]);
  const anchorsByShot = new Map(anchorRows.map((f) => [f.shotId, f]));
  const refs: ShotStalenessRefs = { characters, locations, elements };

  const targets: PlanTarget[] = [];
  // Any target's scene works for the bible load below — the scene only
  // matters to the hash/narrowing paths, not the bible construction.
  let anyScene: Scene | null = null;
  for (const shot of inScope) {
    const frame = anchorsByShot.get(shot.id);
    if (!frame) {
      skipped.push({ shotId: shot.id, reason: 'no-anchor-frame' });
      continue;
    }
    const { scene } = resolveSceneForShot(shot, scriptBySceneId);
    if (!scene) {
      // Shots awaiting script analysis have null metadata. The client's
      // staleness map can still mark such a shot stale (the thumbnail branch
      // runs without a scene), so record the skip rather than dropping it —
      // otherwise the UI waits forever on work that was never planned.
      skipped.push({ shotId: shot.id, reason: 'no-scene' });
      continue;
    }
    const staleness = await computeShotStaleness({
      scopedDb,
      sequence,
      shot,
      frame,
      scene,
      refs,
    });
    // 'unknown' means the comparison failed, not that the artifact is fine.
    // Regenerating on a guess would burn credits; skipping silently would
    // report a clean run. Record it so the user is told.
    if (
      staleness.thumbnail === 'unknown' ||
      staleness.visualPrompt === 'unknown' ||
      staleness.motionPrompt === 'unknown'
    ) {
      skipped.push({ shotId: shot.id, reason: 'staleness-unknown' });
      continue;
    }
    // 'stale' only — 'updating' means a live claim already covers the
    // artifact (this run's dedup, #1085), 'fresh'/'untracked' need nothing.
    const regenVisual = staleness.visualPrompt === 'stale';
    const regenMotion = staleness.motionPrompt === 'stale';
    // Only what reads stale right now. Regenerating the visual prompt
    // outdates the image, but that downstream staleness is left for the
    // indicators to surface rather than cascaded into this run.
    const regenImage = !!frame.imageUrl && staleness.thumbnail === 'stale';
    if (!regenVisual && !regenMotion && !regenImage) continue;

    anyScene ??= scene;
    // Neighbour ids give the motion LLM the same continuity context the
    // single-shot regen path passes (parity with regenerateShotPromptFn:
    // raw metadata, ordered by the sequence's shot list). Resolved to scenes
    // at spawn time — see `PlanTarget`.
    const idx = allShots.findIndex((s) => s.id === shot.id);
    targets.push({
      shotId: shot.id,
      frameId: frame.id,
      beforeShotId: regenMotion ? (allShots[idx - 1]?.id ?? null) : null,
      afterShotId: regenMotion ? (allShots[idx + 1]?.id ?? null) : null,
      startingFrameImageUrl: frame.imageUrl,
      regenVisual,
      regenMotion,
      regenImage,
      visualLiveHash: staleness.liveHashes.visualPrompt,
      motionLiveHash: staleness.liveHashes.motionPrompt,
      imageLiveHash: staleness.liveHashes.thumbnail,
      imageModel: safeTextToImageModel(frame.imageModel, DEFAULT_IMAGE_MODEL),
    });
  }
  if (targets.length === 0 || !anyScene) return planBase;

  // Bibles + style are sequence-wide; load once via the same context loader
  // the single-shot regen path uses.
  const ctx = await loadShotPromptContext({
    scopedDb,
    sequence,
    scene: anyScene,
  });
  return {
    ...planBase,
    promptContext: {
      characterBible: ctx.characterBible,
      locationBible: ctx.locationBible,
      elementBible: ctx.elementBible,
      styleConfig: ctx.styleConfig,
      analysisModelId:
        getAnalysisModelById(ctx.analysisModel)?.id ?? DEFAULT_ANALYSIS_MODEL,
    },
    targets,
  };
}

/**
 * Claim the plan's targets (#1085): pre-create a pending version row per
 * artifact this run will produce, so in-flight work reads as 'updating',
 * duplicate enqueues no-op, and the children complete these rows in place.
 *
 * Runs inside `step.do('claim-targets')` and is idempotent across step
 * retries: an existing live claim stamped with THIS run's instance id is
 * reused; one stamped by anyone else means the artifact is already being
 * produced elsewhere, so this run skips it (reported as `already-in-flight`
 * rather than silently narrowing the run). Exported for testing.
 */
export async function claimTargets(args: {
  scopedDb: ScopedDb;
  targets: PlanTarget[];
  sequenceId: string;
  parentInstanceId: string;
}): Promise<{
  claimsByShot: Record<string, ShotClaims>;
  skipped: SkippedShot[];
}> {
  const { scopedDb, targets, sequenceId, parentInstanceId } = args;
  const claimsByShot: Record<string, ShotClaims> = {};
  const skipped: SkippedShot[] = [];

  for (const target of targets) {
    const claims: ShotClaims = {
      visualVersionId: null,
      motionVersionId: null,
      imageVariantId: null,
    };
    let foreignClaim = false;

    if (target.regenVisual && target.visualLiveHash) {
      const existing = await scopedDb.framePromptVersions.getLivePending(
        target.frameId,
        target.visualLiveHash
      );
      if (existing) {
        if (existing.workflowRunId === parentInstanceId) {
          claims.visualVersionId = existing.id;
        } else {
          foreignClaim = true;
        }
      } else {
        try {
          const row = await scopedDb.framePromptVersions.createPending({
            frameId: target.frameId,
            pendingInputHash: target.visualLiveHash,
            workflowRunId: parentInstanceId,
          });
          claims.visualVersionId = row.id;
        } catch {
          // Lost the insert race to a concurrent enqueue (partial unique
          // index on live claims) — the artifact is already being produced.
          foreignClaim = true;
        }
      }
    }

    if (target.regenMotion && target.motionLiveHash) {
      const existing = await scopedDb.shotPromptVersions.getLivePending(
        target.shotId,
        target.motionLiveHash
      );
      if (existing) {
        if (existing.workflowRunId === parentInstanceId) {
          claims.motionVersionId = existing.id;
        } else {
          foreignClaim = true;
        }
      } else {
        try {
          const row = await scopedDb.shotPromptVersions.createPending({
            shotId: target.shotId,
            pendingInputHash: target.motionLiveHash,
            workflowRunId: parentInstanceId,
          });
          claims.motionVersionId = row.id;
        } catch {
          foreignClaim = true; // lost the insert race — see the visual twin
        }
      }
    }

    if (target.regenImage) {
      const liveClaims = await scopedDb.frameVariants.listLiveClaims(
        target.frameId
      );
      if (target.regenVisual) {
        // Chained render: valid only behind OUR visual claim. A foreign
        // visual claim means someone else owns the prompt regen — chaining
        // onto their run is not this run's call, so skip the image too.
        if (claims.visualVersionId) {
          const visualVersionId = claims.visualVersionId;
          const ours = liveClaims.find(
            (c) => c.dependsOnVersionId === visualVersionId
          );
          claims.imageVariantId =
            ours?.id ??
            (
              await scopedDb.frameVariants.createPendingClaim({
                frameId: target.frameId,
                sequenceId,
                model: target.imageModel,
                dependsOnVersionId: visualVersionId,
                workflowRunId: parentInstanceId,
              })
            ).id;
        } else {
          foreignClaim = true;
        }
      } else if (target.imageLiveHash) {
        const existing = liveClaims.find(
          (c) => c.pendingInputHash === target.imageLiveHash
        );
        if (existing) {
          if (existing.workflowRunId === parentInstanceId) {
            claims.imageVariantId = existing.id;
          } else {
            foreignClaim = true;
          }
        } else {
          try {
            const row = await scopedDb.frameVariants.createPendingClaim({
              frameId: target.frameId,
              sequenceId,
              model: target.imageModel,
              pendingInputHash: target.imageLiveHash,
              workflowRunId: parentInstanceId,
            });
            claims.imageVariantId = row.id;
          } catch {
            foreignClaim = true; // lost the insert race — see the visual twin
          }
        }
      }
    }

    if (foreignClaim) {
      skipped.push({ shotId: target.shotId, reason: 'already-in-flight' });
    }
    claimsByShot[target.shotId] = claims;
  }

  return { claimsByShot, skipped };
}
