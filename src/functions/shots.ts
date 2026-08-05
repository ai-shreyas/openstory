import {
  DEFAULT_IMAGE_MODEL,
  IMAGE_MODELS,
  isValidTextToImageModel,
  safeTextToImageModel,
} from '@/lib/ai/models';
import { getEffectiveFalPricing } from '@/lib/ai/fal-pricing-live';
import { estimateImageCost, gateEstimate } from '@/lib/billing/cost-estimation';
import { requireCredits } from '@/lib/billing/preflight';
import { getWorkflowRunOutcome } from '@/lib/workflow/run-outcome';
import { workflowNameFromRunId } from '@/lib/workflow/trigger-bindings';
import type { NewShot } from '@/lib/db/schema';
import {
  computeShotStaleness,
  UNTRACKED_STALENESS,
  type ShotStalenessRefs,
  type ShotStalenessResult,
} from '@/lib/shots/shot-staleness';
import {
  DEFAULT_UPDATE_STALE_DEPTH,
  UPDATE_STALE_DEPTHS,
} from '@/lib/shots/update-stale-depth';
import {
  projectShotWithImage,
  projectShotMissingFrame,
  type ShotGridSheet,
} from '@/lib/shots/shot-with-image';
import { getVideoDownloadUrl } from '@/lib/motion/video-storage';
import { motionPromptFromVersion } from '@/lib/motion/resolve-motion-prompt';
import { projectVideoVariants } from '@/lib/motion/video-variant-projection';
import {
  bulkShotSchema,
  singleShotSchema,
  updateShotSchema,
} from '@/lib/schemas/shot.schemas';
import { dbSceneId } from '@/lib/db/schema';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { typedFromEntries } from '@/lib/utils/typed-object';
import {
  loadSceneContextBySequence,
  resolveSceneForShot,
} from '@/lib/scenes/scene-script';
import { rescanContinuityFromPrompt } from '@/lib/scenes/rescan-continuity-from-prompt';
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import type { UpdateStaleShotsWorkflowInput } from '@/lib/workflow/types';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import {
  authWithTeamMiddleware,
  shotAccessMiddleware,
  sequenceAccessMiddleware,
} from './middleware';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'serverFn', 'shots']);

const shotIdInputSchema = z.object({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
});

export const getShotsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    const { scopedDb, sequence } = context;
    const shotRows = await scopedDb.shots.listBySequence(sequence.id);
    // Guarantee every shot has its anchor frame, then project the image surface
    // (#989) back under the legacy thumbnail*/image* names so the UI is unchanged.
    await scopedDb.shots.ensureAnchorFrames(shotRows);
    const [anchorRows, gridSheets, motionByShot] = await Promise.all([
      scopedDb.frames.listAnchorsBySequence(sequence.id),
      scopedDb.frameVariants.listLatestGridSheetsBySequence(sequence.id),
      scopedDb.shotPromptVersions.getSelectedMotionByShots(
        shotRows.map((s) => s.id)
      ),
    ]);
    // The still lives on the selected `frame_variants` row and the video on the
    // segment's selected `video_variants` row (#1067) — one batch read each, so
    // projecting the sequence stays O(1) queries.
    const shotIds = shotRows.map((s) => s.id);
    const [
      selectedByFrame,
      selectedPromptByFrame,
      selectedVideoByShot,
      primaryVideoByShot,
    ] = await Promise.all([
      scopedDb.frameVariants.getSelectedByFrameIds(anchorRows.map((f) => f.id)),
      scopedDb.framePromptVersions.getSelectedByFrameIds(
        anchorRows.map((f) => f.id)
      ),
      scopedDb.videoVariants.getSelectedByShotIds(shotIds),
      scopedDb.videoVariants.getPrimaryByShotIds(shotIds),
    ]);
    const anchorsByShot = new Map(anchorRows.map((f) => [f.shotId, f]));
    return shotRows.map((shot) => {
      const frame = anchorsByShot.get(shot.id);
      const selectedMotion = motionByShot.get(shot.id);
      const motionPromptData = selectedMotion
        ? motionPromptFromVersion(selectedMotion)
        : null;
      // `ensureAnchorFrames` above guarantees an anchor for every shot, so this
      // is normally unreachable. If it ever isn't, preserve the shot with a null
      // image surface (matching the sibling read paths in sequences/admin)
      // rather than silently dropping it from the scenes list.
      if (!frame) {
        logger.error(
          `getShotsFn: shot ${shot.id} has no anchor frame after ensureAnchorFrames`
        );
        return projectShotMissingFrame(shot, {
          selectedVideo: selectedVideoByShot.get(shot.id) ?? null,
          primaryVideo: primaryVideoByShot.get(shot.id) ?? null,
        });
      }
      // Grid sheets are keyed by frame id (#989), resolved from the anchor.
      const sheet = gridSheets.get(frame.id);
      const gridSheet: ShotGridSheet | null = sheet
        ? { url: sheet.url, status: sheet.status }
        : null;
      return projectShotWithImage(shot, frame, {
        selectedImage: selectedByFrame.get(frame.id) ?? null,
        selectedImagePrompt: selectedPromptByFrame.get(frame.id) ?? null,
        selectedVideo: selectedVideoByShot.get(shot.id) ?? null,
        primaryVideo: primaryVideoByShot.get(shot.id) ?? null,
        gridSheet,
        motionPromptData,
      });
    });
  });

/**
 * Batched variant of `getShotsFn` for list-style pages that need shots for
 * many sequences at once. The sequences list page used to fire one
 * `getShotsFn` per row; with 50+ sequences this saturated iOS Chrome's
 * connection pool, queued every subsequent navigation request, and killed
 * the WebProcess (root cause of the "Can't open this page" report).
 *
 * Team scoping is enforced by the join inside `sequences.listShotsByIds`,
 * so caller-supplied ids from another team return nothing rather than leak.
 * `listShotsByIds` chunks the ids to respect D1's bound-parameter limit, so
 * the cap here is only an abuse guard on request size — a team's full sequence
 * list (which the sequences/eval pages send) used to overflow the old 500 cap
 * once it grew past 500 sequences (#957).
 */
export const getShotsForSequencesFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceIds: z.array(ulidSchema).max(5000),
      })
    )
  )
  .handler(async ({ data, context }) => {
    return context.scopedDb.sequences.listShotsByIds(data.sequenceIds);
  });

export const getShotFn = createServerFn({ method: 'GET' })
  .middleware([shotAccessMiddleware])
  .handler(async ({ context }) => {
    const [
      sheet,
      selectedMotion,
      selectedImage,
      selectedImagePrompt,
      selectedVideo,
      primaryVideo,
    ] = await Promise.all([
      context.scopedDb.frameVariants.getLatestGridSheet(context.frame.id),
      context.scopedDb.shotPromptVersions.getSelectedMotion(context.shot.id),
      context.scopedDb.frameVariants.getSelected(context.frame.id),
      context.scopedDb.framePromptVersions.getSelected(context.frame.id),
      context.scopedDb.videoVariants.getSelectedByShot(context.shot.id),
      context.scopedDb.videoVariants.getPrimaryByShot(context.shot.id),
    ]);
    return projectShotWithImage(context.shot, context.frame, {
      selectedImage,
      selectedImagePrompt,
      selectedVideo,
      primaryVideo,
      gridSheet: sheet ? { url: sheet.url, status: sheet.status } : null,
      motionPromptData: selectedMotion
        ? motionPromptFromVersion(selectedMotion)
        : null,
    });
  });

export const getSequenceImageModelsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    const models = await context.scopedDb.frameVariants.listModelsForSequence(
      context.sequence.id
    );
    // Preview thumbnails are generated with a hidden internal model
    // (PREVIEW_IMAGE_MODEL = flux_2_turbo) and stored as image variants. Hide
    // such hidden models from the user-facing sequence image-model list — they
    // aren't a real choice and only confuse the header dropdown.
    return models.filter(
      (model) =>
        !(isValidTextToImageModel(model) && 'hidden' in IMAGE_MODELS[model])
    );
  });

export const getSequenceVideoModelsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    // Video models now come from `video_variants` (#990).
    return context.scopedDb.videoVariants.listModelsForSequence(
      context.sequence.id
    );
  });

export const getDivergentVariantsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.shotVariants.listDivergentBySequence(
      context.sequence.id
    );
  });

/**
 * Promote a divergent `shot_variants` alternate to the live primary.
 *
 * Every variant type this once served has since moved off `shot_variants`, so
 * there is nothing left to promote:
 * - image → `frame_variants`, selected by pointer (#989)
 * - video → `video_variants`, selected by the segment pointer (#990); #1067
 *   phase 2d then dropped the `shots.video*` columns this wrote into, so the
 *   copy-onto-the-shot model has no target at all
 * - audio → never existed per-shot; music is sequence-level (#1067)
 *
 * Divergence itself is retired with them: `projectVideoVariants` hardcodes
 * `divergedAt: null`, so `listDivergentBySequence` can only ever surface rows
 * written before those cutovers. Deleting the remaining `shot_variants` surface
 * is explicitly out of scope for #1067, so the endpoint stays (the client still
 * imports it) and fails loudly rather than silently doing nothing.
 */
export const promoteVariantFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        shotId: ulidSchema,
        variantId: ulidSchema,
      })
    )
  )
  .handler(async () => {
    throw new Error(
      'Promoting a divergent alternate is retired — pick a version from the shot’s video history instead (selectSegmentVideoVersionFn), or a model via setVideoFromVariantFn.'
    );
  });

export const discardVariantFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        shotId: ulidSchema,
        variantId: ulidSchema,
      })
    )
  )
  .handler(async ({ data, context }) => {
    const variant = await context.scopedDb.shotVariants.getById(data.variantId);
    if (!variant || variant.shotId !== context.shot.id) {
      throw new Error('Variant not found for this shot');
    }
    const discardedAt = await context.scopedDb.shotVariants.discard(variant.id);
    return { variantId: variant.id, discardedAt };
  });

export const undiscardVariantFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        shotId: ulidSchema,
        variantId: ulidSchema,
      })
    )
  )
  .handler(async ({ data, context }) => {
    const variant = await context.scopedDb.shotVariants.getById(data.variantId);
    if (!variant || variant.shotId !== context.shot.id) {
      throw new Error('Variant not found for this shot');
    }
    await context.scopedDb.shotVariants.undiscard(variant.id);
    return { variantId: variant.id };
  });

export const getSequenceImageVariantsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    // Image variants moved to `frame_variants` (#989). Each row carries its
    // owning `shotId` (frame ids ≠ shot ids) so the client coverage logic keyed
    // by shot keeps working.
    return context.scopedDb.frameVariants.listModelVersionsBySequence(
      context.sequence.id
    );
  });

export const getSequenceVideoVariantsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    // Video lives in `video_variants` now (#990). Project it into the legacy
    // per-(shot, model) `ShotVariant` shape so the scenes-view switcher /
    // coverage keep reading the same fields (latest version per shot+model;
    // `divergedAt` always null — selection is a pointer).
    const versions = await context.scopedDb.videoVariants.listBySequence(
      context.sequence.id
    );
    return projectVideoVariants(versions);
  });

/**
 * The model recorded on each shot's SELECTED image / video version (#1066).
 * Model identity lives on the version row that produced the asset, so the
 * editor resolves the model it shows (and generates with) from this — via the
 * same `resolveImageModel`/`resolveVideoModel` the server write paths use.
 * Shots with no selection are simply absent, and the caller falls back to the
 * sequence default.
 */
export const getSequenceSelectedModelsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    const [image, video, failedImage, failedVideo] = await Promise.all([
      context.scopedDb.frameVariants.listSelectedModelsBySequence(
        context.sequence.id
      ),
      context.scopedDb.videoVariants.listSelectedModelsBySequence(
        context.sequence.id
      ),
      context.scopedDb.frameVariants.listLastFailedModelsBySequence(
        context.sequence.id
      ),
      context.scopedDb.videoVariants.listLastFailedModelsBySequence(
        context.sequence.id
      ),
    ]);
    // Plain records, not Maps — this crosses the server-fn JSON boundary.
    return {
      imageModelByShot: typedFromEntries([...image]),
      videoModelByShot: typedFromEntries([...video]),
      // The failed-attempt tier, so the editor shows the same model a retry
      // would run (#1066) rather than the older selected one.
      failedImageModelByShot: typedFromEntries([...failedImage]),
      failedVideoModelByShot: typedFromEntries([...failedVideo]),
    };
  });

export const createShotFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(singleShotSchema.extend({ sequenceId: ulidSchema }))
  )
  .handler(async ({ data, context }) => {
    return context.scopedDb.shots.create(data);
  });

export const createShotsBulkFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        shots: bulkShotSchema.shape.shots,
      })
    )
  )
  .handler(async ({ data, context }) => {
    const shotInserts: NewShot[] = data.shots.map((shot) => ({
      sequenceId: data.sequenceId,
      ...shot,
    }));
    return context.scopedDb.shots.bulkUpsert(shotInserts);
  });

export const updateShotFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .inputValidator(
    zodValidator(
      updateShotSchema.extend({ sequenceId: ulidSchema, shotId: ulidSchema })
    )
  )
  .handler(async ({ data, context }) => {
    const { sequenceId, shotId, ...updateData } = data;

    // When a user edits a prompt, auto-link any element/cast/location tags
    // they mentioned by additively merging them into the scene's continuity
    // so the next generation pulls those references in (#683). Skip when the
    // prompt value hasn't actually changed, so plain saves stay a single
    // UPDATE with no extra reads.
    const imagePromptChanged =
      updateData.imagePrompt !== undefined &&
      updateData.imagePrompt !== context.frame.imagePrompt;
    const selectedMotion =
      updateData.motionPrompt === undefined
        ? null
        : await context.scopedDb.shotPromptVersions.getSelectedMotion(shotId);
    const motionPromptChanged =
      updateData.motionPrompt !== undefined &&
      updateData.motionPrompt !== (selectedMotion?.text ?? null);
    const sceneContinuity = context.scene?.continuity;
    if ((imagePromptChanged || motionPromptChanged) && sceneContinuity) {
      const promptText = [
        imagePromptChanged ? updateData.imagePrompt : null,
        motionPromptChanged ? updateData.motionPrompt : null,
      ]
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .join('\n');

      const rescan = await rescanContinuityFromPrompt({
        scopedDb: context.scopedDb,
        sequenceId,
        existing: sceneContinuity,
        promptText,
      });

      // Continuity is scene-scoped: auto-linking script tokens describes the
      // scene, not one of its shots.
      if (rescan.changed && context.shot.sceneId) {
        await context.scopedDb.scenes.update(
          dbSceneId(context.shot.sceneId),
          { continuity: rescan.continuity },
          { throwOnMissing: false }
        );
      }
    }

    // Neither prompt is a `shots` column: the image prompt lives on the anchor
    // frame (#989) and the motion prompt on its selected `shot_prompt_versions`
    // row (#713). Persist each changed prompt as a user-edit version (which
    // mirrors + repoints the pointer), then drop both from the shots UPDATE.
    const {
      imagePrompt: editedImagePrompt,
      motionPrompt: editedMotionPrompt,
      ...shotUpdate
    } = updateData;
    if (
      imagePromptChanged &&
      typeof editedImagePrompt === 'string' &&
      editedImagePrompt.length > 0
    ) {
      await context.scopedDb.framePromptVersions.write({
        frameId: context.frame.id,
        text: editedImagePrompt,
        source: 'user-edit',
        inputHash: null,
        analysisModel: null,
        createdBy: context.user.id,
      });
    }
    if (
      motionPromptChanged &&
      typeof editedMotionPrompt === 'string' &&
      editedMotionPrompt.length > 0
    ) {
      await context.scopedDb.shotPromptVersions.write({
        shotId,
        promptType: 'motion',
        text: editedMotionPrompt,
        dialogue: selectedMotion?.dialogue ?? null,
        audio: selectedMotion?.audio ?? null,
        source: 'user-edit',
        inputHash: null,
        analysisModel: null,
        createdBy: context.user.id,
      });
    }

    return context.scopedDb.shots.update(shotId, shotUpdate);
  });

const updateShotDurationSchema = z.object({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
  durationSeconds: z.number().positive(),
});

/**
 * Set a shot's duration — a **video** parameter, not a prompt driver.
 *
 * `sceneInputContext` (input-hash.ts) deliberately allowlists `durationSeconds`
 * OUT of the prompt hashes, so changing it re-stales the render
 * (`computeShotVideoInputHash`) and nothing else. That's why this is its own
 * endpoint rather than a field on `updateSceneScriptFn`: a duration edit must
 * not append a `scene_script_versions` row or touch prompt staleness.
 *
 * A scene has no duration of its own — its duration is the sum of its shots'
 * (`tileSceneIntoSegments` reads exactly these values against the model cap).
 */
export const updateShotDurationFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .inputValidator(zodValidator(updateShotDurationSchema))
  .handler(async ({ data, context }) => {
    const { shot, scopedDb } = context;
    const updated = await scopedDb.shots.update(shot.id, {
      durationMs: Math.round(data.durationSeconds * 1000),
    });
    return updated ?? shot;
  });

export const deleteShotFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .inputValidator(zodValidator(shotIdInputSchema))
  .handler(async ({ data, context }) => {
    await context.scopedDb.shots.delete(data.shotId);
    return { success: true, sequenceId: data.sequenceId };
  });

export const deleteShotsBySequenceFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    await context.scopedDb.shots.deleteBySequence(context.sequence.id);
    return { success: true };
  });

/**
 * Returns staleness state for a shot's artifacts. Covers the rendered
 * thumbnail plus the visual / motion prompts (stage 4). See
 * `computeShotStaleness` (lib/shots/shot-staleness.ts) for the comparison
 * rules and the per-artifact states.
 */
export const getShotStalenessFn = createServerFn({ method: 'GET' })
  .middleware([shotAccessMiddleware])
  .inputValidator(zodValidator(shotIdInputSchema))
  .handler(async ({ context }) => {
    const { shot, frame, sequence, scopedDb, scene } = context;
    return toWireStaleness(
      await computeShotStaleness({
        scopedDb,
        sequence,
        shot,
        frame,
        selectedImage: await scopedDb.frameVariants.getSelected(frame.id),
        scene,
      })
    );
  });

/**
 * The client-facing slice of a staleness result. `liveHashes` is a server-side
 * convenience for the enqueue paths (#1085) and stays off the wire.
 */
const toWireStaleness = ({
  thumbnail,
  visualPrompt,
  motionPrompt,
}: ShotStalenessResult) => ({ thumbnail, visualPrompt, motionPrompt });

/**
 * Batched `getShotStalenessFn` (#1077): staleness for every shot in one scene
 * (`sceneId` set) or the whole sequence (`sceneId` omitted), keyed by shot
 * id. Feeds the Scene/Sequence panel's stale-shot summary and the left-rail
 * dots, and lets the client prime the per-shot staleness cache entries in one
 * round trip instead of N.
 */
export const getShotStalenessBatchFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({ sequenceId: ulidSchema, sceneId: ulidSchema.optional() })
    )
  )
  .handler(async ({ data, context }) => {
    const { scopedDb, sequence } = context;
    const allShots = await scopedDb.shots.listBySequence(sequence.id);
    const targetShots = data.sceneId
      ? allShots.filter((shot) => shot.sceneId === data.sceneId)
      : allShots;
    if (targetShots.length === 0) {
      return {};
    }

    await scopedDb.shots.ensureAnchorFrames(targetShots);
    // Loaded once here and threaded into every shot's comparison as `refs`;
    // without that each shot would re-read all four for both prompt branches.
    const [
      anchorRows,
      scriptBySceneId,
      characters,
      locations,
      elements,
      style,
    ] = await Promise.all([
      scopedDb.frames.listAnchorsBySequence(sequence.id),
      loadSceneContextBySequence(scopedDb, sequence.id),
      scopedDb.characters.listWithSheets(sequence.id),
      scopedDb.sequenceLocations.listWithReferences(sequence.id),
      scopedDb.sequenceElements.list(sequence.id),
      sequence.styleId
        ? scopedDb.styles.getById(sequence.styleId)
        : Promise.resolve(null),
    ]);
    const anchorsByShot = new Map(anchorRows.map((f) => [f.shotId, f]));
    // Stills live on the selected `frame_variants` rows (#1067) — batched here
    // alongside `refs` for the same reason: one read, not one per shot.
    const selectedByFrame = await scopedDb.frameVariants.getSelectedByFrameIds(
      anchorRows.map((f) => f.id)
    );
    const refs: ShotStalenessRefs = { characters, locations, elements, style };

    const entries = await Promise.all(
      targetShots.map(
        async (shot): Promise<[string, ReturnType<typeof toWireStaleness>]> => {
          const frame = anchorsByShot.get(shot.id);
          if (!frame) {
            // ensureAnchorFrames guarantees an anchor; if it's somehow absent
            // we have no image surface to compare, so report the shot
            // untracked rather than dropping it from the result.
            logger.error(
              `getShotStalenessBatchFn: shot ${shot.id} has no anchor frame`
            );
            return [shot.id, toWireStaleness(UNTRACKED_STALENESS)];
          }
          const { scene } = resolveSceneForShot(shot, scriptBySceneId);
          try {
            return [
              shot.id,
              toWireStaleness(
                await computeShotStaleness({
                  scopedDb,
                  sequence,
                  shot,
                  frame,
                  selectedImage: selectedByFrame.get(frame.id) ?? null,
                  scene,
                  refs,
                })
              ),
            ];
          } catch (error) {
            // Per-shot boundary: anything escaping computeShotStaleness must
            // not reject the whole batch and blank the scene.
            logger.error(
              `getShotStalenessBatchFn: shot ${shot.id} staleness failed`,
              { err: error }
            );
            return [shot.id, toWireStaleness(UNTRACKED_STALENESS)];
          }
        }
      )
    );
    return typedFromEntries(entries);
  });

/**
 * "Update all" (#1077, depth picker #1085): enqueue the durable
 * `UpdateStaleShotsWorkflow` for a shot / scene / the whole sequence. The
 * workflow recomputes staleness server-side and regenerates what reads stale
 * up to the chosen `depth` cascade — at 'images' and above a regenerated
 * prompt cascades into its still; at 'video'/'music' existing videos and
 * music re-render behind their regenerated upstreams (never a FIRST render).
 * Returns the run id; progress surfaces through the staleness indicators as
 * artifacts land.
 *
 * Preflights credits before enqueuing. Inside the workflow an out-of-credits
 * failure can only land in the run result, where it reads as "nothing
 * happened" — throwing here is the one point where the client still gets an
 * `InsufficientCreditsError` and can open the billing dialog.
 */
export const updateStaleShotsFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        sceneId: ulidSchema.optional(),
        shotId: ulidSchema.optional(),
        depth: z.enum(UPDATE_STALE_DEPTHS).optional(),
      })
    )
  )
  .handler(async ({ data, context }) => {
    const { sequence, teamId, user, scopedDb } = context;
    const depth = data.depth ?? DEFAULT_UPDATE_STALE_DEPTH;
    // The plan isn't known yet, so this can't be the exact cost — it's a
    // floor: a run that can't afford even one artifact of its most expensive
    // level should never start. 'prompts' has no render cost; LLM spend is
    // deducted inside the workflow as always.
    if (depth !== 'prompts') {
      const model = safeTextToImageModel(
        sequence.imageModel,
        DEFAULT_IMAGE_MODEL
      );
      await requireCredits(
        scopedDb,
        gateEstimate(
          estimateImageCost(model, sequence.aspectRatio, 1, {
            pricing: await getEffectiveFalPricing(),
          }),
          { model, operation: 'update-stale-shots' }
        ),
        { errorMessage: 'Insufficient credits to update out-of-date shots' }
      );
    }
    const workflowRunId = await triggerWorkflow<UpdateStaleShotsWorkflowInput>(
      '/update-stale-shots',
      {
        userId: user.id,
        teamId,
        sequenceId: sequence.id,
        sceneId: data.sceneId,
        shotId: data.shotId,
        depth,
      },
      {
        label: buildWorkflowLabel(sequence.id),
        // Embed the sequence id in the instance id (the timestamp+uuid tail
        // keeps it unique per click) so `getUpdateStaleShotsRunFn` can verify
        // a polled run id actually belongs to the sequence being authorized —
        // without this, any authenticated user could read any run's output.
        deduplicationId: `${sequence.id}-${Date.now()}-${crypto.randomUUID()}`,
      }
    );
    return { workflowRunId };
  });

/**
 * Shape of `UpdateStaleShotsWorkflow`'s return value. Parsed rather than cast:
 * it crosses the Cloudflare Workflows boundary as `unknown`, and a run from a
 * previously-deployed version of the workflow can legitimately not match.
 */
const updateStaleShotsResultSchema = z.object({
  totalShots: z.number(),
  visualPrompts: z.number(),
  motionPrompts: z.number(),
  images: z.number(),
  // Depth-picker levels (#1085). Defaulted so a run from a pre-picker
  // deployment still parses during version skew.
  videos: z.number().default(0),
  musicPrompts: z.number().default(0),
  musicTracks: z.number().default(0),
  failures: z.array(
    z.object({ shotId: z.string(), stage: z.string(), error: z.string() })
  ),
  skipped: z.array(z.object({ shotId: z.string(), reason: z.string() })),
});

/**
 * Terminal outcome of an "Update all" run (#1077).
 *
 * The workflow isolates failures per shot so one bad shot never blocks its
 * peers — which means a run can finish `complete` having regenerated nothing.
 * Without this endpoint that result is written to a log nobody reads and the
 * user just watches a spinner stop. The client polls this and reports what
 * actually happened.
 */
export const getUpdateStaleShotsRunFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({ sequenceId: ulidSchema, workflowRunId: z.string().min(1) })
    )
  )
  .handler(async ({ data, context }) => {
    // The middleware authorizes the SEQUENCE; the run id is caller-supplied
    // and would otherwise let any authenticated user read any run's output.
    // `updateStaleShotsFn` embeds the sequence id in the instance id — require
    // both the right workflow and the right sequence before reading anything.
    if (
      workflowNameFromRunId(data.workflowRunId) !== 'update-stale-shots' ||
      !data.workflowRunId.includes(context.sequence.id)
    ) {
      return { state: 'unknown' as const };
    }
    const outcome = await getWorkflowRunOutcome(data.workflowRunId);
    if (outcome.state !== 'complete') return outcome;
    const parsed = updateStaleShotsResultSchema.safeParse(outcome.output);
    // A complete run whose output we can't read is not a failure to report as
    // one — fall back to 'unknown' so the UI defers to the staleness map.
    if (!parsed.success) {
      logger.error(
        `getUpdateStaleShotsRunFn: unrecognised output for ${data.workflowRunId}`,
        { issues: parsed.error.issues }
      );
      return { state: 'unknown' as const };
    }
    return { state: 'complete' as const, result: parsed.data };
  });

/**
 * Get a signed download URL for a shot's video.
 * Uses Content-Disposition: attachment to force browser download.
 */
export const getShotDownloadUrlFn = createServerFn({ method: 'GET' })
  .middleware([shotAccessMiddleware])
  .inputValidator(zodValidator(shotIdInputSchema))
  .handler(async ({ context }) => {
    const { shot, scopedDb } = context;

    // The downloadable file is whichever version the shot's segment points at
    // (#1067 phase 2d) — `shots.videoPath` is gone.
    const selectedVideo = await scopedDb.videoVariants.getSelectedByShot(
      shot.id
    );
    const storagePath = selectedVideo?.storagePath;
    if (!storagePath) {
      throw new Error('Shot does not have a video');
    }

    const filename =
      storagePath.split('/').pop() || `scene-${shot.id}_openstory.mp4`;

    const downloadUrl = await getVideoDownloadUrl(storagePath, filename, 3600);

    return { downloadUrl, filename };
  });
