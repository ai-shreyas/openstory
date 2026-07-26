import {
  DEFAULT_IMAGE_MODEL,
  IMAGE_MODELS,
  isValidTextToImageModel,
  safeTextToImageModel,
} from '@/lib/ai/models';
import {
  computeMotionPromptInputHash,
  computeVisualPromptInputHash,
} from '@/lib/ai/input-hash';
import { loadNarrowShotPromptContext } from '@/lib/ai/prompt-context';
import type { ShotVariant, NewShot } from '@/lib/db/schema';
import {
  projectShotWithImage,
  projectShotMissingFrame,
  type ShotGridSheet,
} from '@/lib/shots/shot-with-image';
import { getGenerationChannel } from '@/lib/realtime';
import { getVideoDownloadUrl } from '@/lib/motion/video-storage';
import { motionPromptFromVersion } from '@/lib/motion/resolve-motion-prompt';
import { projectVideoVariants } from '@/lib/motion/video-variant-projection';
import {
  bulkShotSchema,
  singleShotSchema,
  updateShotSchema,
} from '@/lib/schemas/shot.schemas';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { typedFromEntries } from '@/lib/utils/typed-object';
import {
  enrichShotWithSceneScript,
  loadSelectedScriptsBySequence,
  projectShotForClient,
} from '@/lib/scenes/scene-script';
import { rescanContinuityFromPrompt } from '@/lib/scenes/rescan-continuity-from-prompt';
import { buildRegenerateShotSnapshot } from '@/lib/workflows/regenerate-shots-snapshot';
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
    const [anchorRows, gridSheets, motionByShot, scriptBySceneId] =
      await Promise.all([
        scopedDb.frames.listAnchorsBySequence(sequence.id),
        scopedDb.frameVariants.listLatestGridSheetsBySequence(sequence.id),
        scopedDb.shotPromptVersions.getSelectedMotionByShots(
          shotRows.map((s) => s.id)
        ),
        loadSelectedScriptsBySequence(scopedDb, sequence.id),
      ]);
    const anchorsByShot = new Map(anchorRows.map((f) => [f.shotId, f]));
    return shotRows.map((rawShot) => {
      const shot = enrichShotWithSceneScript(rawShot, scriptBySceneId);
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
        return projectShotMissingFrame(shot);
      }
      // Grid sheets are keyed by frame id (#989), resolved from the anchor.
      const sheet = gridSheets.get(frame.id);
      const gridSheet: ShotGridSheet | null = sheet
        ? { url: sheet.url, status: sheet.status }
        : null;
      return projectShotWithImage(shot, frame, gridSheet, motionPromptData);
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
    const [sheet, selectedMotion] = await Promise.all([
      context.scopedDb.frameVariants.getLatestGridSheet(context.frame.id),
      context.scopedDb.shotPromptVersions.getSelectedMotion(context.shot.id),
    ]);
    const shot = projectShotForClient(context.shot, context.script);
    return projectShotWithImage(
      shot,
      context.frame,
      sheet ? { url: sheet.url, status: sheet.status } : null,
      selectedMotion ? motionPromptFromVersion(selectedMotion) : null
    );
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

type PromoteProgressEvent = 'video:progress' | 'audio:progress';
type PromoteProgressUrlField = 'videoUrl' | 'audioUrl';

/**
 * Build the per-variantType `shots` update payload and matching realtime
 * progress event metadata for a promote-variant operation. Exported (and
 * pure) for unit testing — the server-fn handler wraps this in auth +
 * persistence.
 *
 * Image promotion is retired (#989): image variants live in `frame_variants`
 * and selection is a pointer repoint via `setImageFromVariantFn` /
 * `frameVariants.select`, not a divergent-alternate promote. This only handles
 * the video/audio variants that still live on `shot_variants`.
 */
export function buildPromoteUpdate(variant: ShotVariant): {
  update: Partial<NewShot>;
  progressEvent: PromoteProgressEvent;
  progressUrlField: PromoteProgressUrlField;
} {
  const update: Partial<NewShot> = {};
  let progressEvent: PromoteProgressEvent;
  let progressUrlField: PromoteProgressUrlField;

  switch (variant.variantType) {
    case 'image':
      throw new Error(
        'Image variants are not promoted — select via frameVariants.select (#989)'
      );
    case 'video':
      update.videoUrl = variant.url;
      update.videoPath = variant.storagePath;
      update.videoStatus = 'completed';
      update.videoError = null;
      update.videoInputHash = variant.inputHash;
      progressEvent = 'video:progress';
      progressUrlField = 'videoUrl';
      break;
    case 'audio':
      update.audioUrl = variant.url;
      update.audioPath = variant.storagePath;
      update.audioStatus = 'completed';
      update.audioError = null;
      update.audioInputHash = variant.inputHash;
      progressEvent = 'audio:progress';
      progressUrlField = 'audioUrl';
      break;
  }

  return { update, progressEvent, progressUrlField };
}

/**
 * Promote a divergent alternate to be the live primary for its variant type.
 * Copies the variant's url/path into the matching shots column, updates the
 * matching `*_input_hash` so the live row reflects the alternate's inputs,
 * soft-deletes the variant, and emits a synthetic `*:progress` event so any
 * listeners refresh.
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
  .handler(async ({ data, context }) => {
    const { shot, scopedDb } = context;
    const variant = await scopedDb.shotVariants.getById(data.variantId);
    if (!variant || variant.shotId !== shot.id) {
      throw new Error('Variant not found for this shot');
    }
    if (variant.divergedAt === null || variant.discardedAt !== null) {
      throw new Error('Variant is not a live divergent alternate');
    }
    if (!variant.url) {
      throw new Error('Variant has no asset to promote');
    }

    const { update, progressEvent, progressUrlField } =
      buildPromoteUpdate(variant);

    // Atomic: a partial failure can't leave the live primary updated with the
    // variant still appearing in the divergent list (or vice versa).
    const { shot: updatedShot } = await scopedDb.shotVariants.promoteAtomically(
      shot.id,
      update,
      variant.id
    );

    // Realtime emit is purely cache-busting — TanStack Query refetches on the
    // mutation onSuccess invalidation regardless. A failed emit must not
    // surface to the user as "promote failed" when the DB already committed.
    const channel = getGenerationChannel(data.sequenceId);
    try {
      const url = updatedShot[progressUrlField] ?? variant.url;
      await channel.emit(
        `generation.${progressEvent}`,
        progressEvent === 'audio:progress'
          ? {
              shotId: shot.id,
              status: 'completed',
              audioUrl: url,
            }
          : {
              shotId: shot.id,
              status: 'completed',
              videoUrl: url,
              model: variant.model,
            }
      );
    } catch (error) {
      logger.error('realtime emit failed', { err: error });
    }

    return { shot: updatedShot, variantId: variant.id };
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

    // Scene-script edits route through `updateSceneScriptFn` (#1030). Reject
    // legacy metadata.originalScript writes so the shot copy stays write-only.
    if (updateData.metadata?.originalScript?.extract !== undefined) {
      throw new Error(
        'Scene script edits must use updateSceneScriptFn (#1030)'
      );
    }

    // When a user edits a prompt, auto-link any element/cast/location tags
    // they mentioned by additively merging them into shot.metadata.continuity
    // so the next generation pulls those references in (#683). Skip when the
    // prompt value hasn't actually changed, so plain saves stay a single
    // UPDATE with no extra reads.
    const imagePromptChanged =
      updateData.imagePrompt !== undefined &&
      updateData.imagePrompt !== context.frame.imagePrompt;
    const motionPromptChanged =
      updateData.motionPrompt !== undefined &&
      updateData.motionPrompt !== context.shot.motionPrompt;
    const shotMetadata = context.shot.metadata;
    if (
      (imagePromptChanged || motionPromptChanged) &&
      shotMetadata?.continuity
    ) {
      const promptText = [
        imagePromptChanged ? updateData.imagePrompt : null,
        motionPromptChanged ? updateData.motionPrompt : null,
      ]
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .join('\n');

      const rescan = await rescanContinuityFromPrompt({
        scopedDb: context.scopedDb,
        sequenceId,
        existing: shotMetadata.continuity,
        promptText,
      });

      if (rescan.changed) {
        updateData.metadata = {
          ...shotMetadata,
          continuity: rescan.continuity,
        };
      }
    }

    // The image prompt lives on the anchor frame (#989), not a `shots` column.
    // Persist a changed prompt as a user-edit `frame_prompt_versions` row (which
    // mirrors it onto `frame.imagePrompt` + repoints the pointer), then drop it
    // from the shots UPDATE.
    const { imagePrompt: editedImagePrompt, ...shotUpdate } = updateData;
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

    return context.scopedDb.shots.update(shotId, shotUpdate);
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

export const reorderShotsFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        shotOrders: z
          .array(z.object({ id: ulidSchema, orderIndex: z.number().int() }))
          .min(1),
      })
    )
  )
  .handler(async ({ data, context }) => {
    const shotOrders = data.shotOrders.map((f) => ({
      id: f.id,
      order_index: f.orderIndex,
    }));
    await context.scopedDb.shots.reorder(data.sequenceId, shotOrders);
    return { success: true };
  });

/**
 * Returns staleness state for a shot's artifacts. Covers the rendered
 * thumbnail plus the visual / motion prompts (stage 4). Each value is
 * computed by re-deriving the current input hash from live scoped state and
 * comparing it to the stored `*_input_hash` via the scoped helper.
 *
 * Three states per artifact:
 *   - `'stale'`     — stored hash diverges from the freshly computed one.
 *   - `'fresh'`     — stored hash matches.
 *   - `'untracked'` — no stored hash (legacy artifact, or never generated).
 *                     Distinct from `'fresh'` so the UI can suppress the
 *                     regenerate prompt without lying about the artifact's
 *                     freshness.
 */
export const getShotStalenessFn = createServerFn({ method: 'GET' })
  .middleware([shotAccessMiddleware])
  .inputValidator(zodValidator(shotIdInputSchema))
  .handler(async ({ context }) => {
    const { shot, frame, sequence, scopedDb, scene } = context;
    const shotForHash = scene ? { ...shot, metadata: scene } : shot;

    let thumbnail: 'stale' | 'fresh' | 'untracked' = 'untracked';
    // The visual prompt lives solely on the anchor frame's `imagePrompt` mirror
    // now (#989/#713): the visual-prompt workflow writes a `frame_prompt_versions`
    // row that mirrors onto `frame.imagePrompt`, so AI-generated and regenerated
    // shots both populate it — the old `metadata.prompts.visual` fallback is gone.
    const effectivePrompt = frame.imagePrompt;
    if (effectivePrompt) {
      // Distinguish "stored hash absent" from "stored hash matches". A null
      // stored hash means the image predates hash tracking (or was generated
      // by a pre-fix `generateShotImageFn` that didn't pass a sceneSnapshot)
      // — we genuinely have no opinion, so 'untracked' rather than lying with
      // 'fresh'. Once the user regenerates the image once under the new code
      // path, this column populates and the live-vs-stored comparison takes
      // over.
      if (frame.imageInputHash === null) {
        thumbnail = 'untracked';
      } else {
        try {
          const [characters, locations, elements] = await Promise.all([
            scopedDb.characters.listWithSheets(sequence.id),
            scopedDb.sequenceLocations.listWithReferences(sequence.id),
            scopedDb.sequenceElements.list(sequence.id),
          ]);

          const snapshot = await buildRegenerateShotSnapshot({
            shot: shotForHash,
            imagePrompt: frame.imagePrompt,
            characters,
            locations,
            elements,
            imageModel: safeTextToImageModel(
              frame.imageModel,
              DEFAULT_IMAGE_MODEL
            ),
            aspectRatio: sequence.aspectRatio,
          });

          thumbnail =
            snapshot.snapshotInputHash !== frame.imageInputHash
              ? 'stale'
              : 'fresh';
        } catch (error) {
          // Mirror the visual/motion branches: a thumbnail-hash failure (e.g.
          // transient D1 read, malformed element/location row) must not throw
          // out of the whole handler — that would null the entire staleness
          // result and silently suppress the visual/motion banners too. Stay
          // 'untracked' (fail-open as 'fresh' would lie about freshness).
          logger.warn(`thumbnail staleness uncomputable for shot ${shot.id}:`, {
            err: error,
          });
        }
      }
    }

    let visualPrompt: 'stale' | 'fresh' | 'untracked' = 'untracked';
    let motionPrompt: 'stale' | 'fresh' | 'untracked' = 'untracked';

    // Reference hash resolution: prefer the cached column on `shots`, but
    // fall back to the most recent variant with a non-null `inputHash` for
    // shots whose cached column was nulled by a pre-fix user-edit. Without
    // the fallback, those shots are stuck at `'untracked'` permanently.
    if (scene) {
      // Visual prompt history moved to `frame_prompt_versions` (#989); the
      // cached hash mirror lives on the anchor frame.
      let referenceHash = frame.visualPromptInputHash;
      if (!referenceHash) {
        const fallback =
          await scopedDb.framePromptVersions.getLatestWithInputHash(frame.id);
        referenceHash = fallback?.inputHash ?? null;
      }
      if (referenceHash) {
        try {
          const latest = await scopedDb.framePromptVersions.getLatest(frame.id);
          const ctx = await loadNarrowShotPromptContext({
            scopedDb,
            sequence,
            scene,
            analysisModelOverride: latest?.analysisModel ?? null,
          });
          const liveHash = await computeVisualPromptInputHash(ctx);
          visualPrompt = liveHash !== referenceHash ? 'stale' : 'fresh';
        } catch (error) {
          // Context unavailable (e.g., style deleted mid-flight). Stay
          // 'untracked' — fail-open as 'fresh' would silently lie to the user.
          logger.warn(`visual staleness uncomputable for shot ${shot.id}:`, {
            err: error,
          });
        }
      }
    }

    if (scene) {
      let referenceHash = shot.motionPromptInputHash;
      if (!referenceHash) {
        const fallback =
          await scopedDb.shotPromptVersions.getLatestWithInputHash(
            shot.id,
            'motion'
          );
        referenceHash = fallback?.inputHash ?? null;
      }
      if (referenceHash) {
        try {
          const latest = await scopedDb.shotPromptVersions.getLatest(
            shot.id,
            'motion'
          );
          const ctx = await loadNarrowShotPromptContext({
            scopedDb,
            sequence,
            scene,
            analysisModelOverride: latest?.analysisModel ?? null,
            startingFrameImageUrl: frame.imageUrl,
          });
          const liveHash = await computeMotionPromptInputHash(ctx);
          motionPrompt = liveHash !== referenceHash ? 'stale' : 'fresh';
        } catch (error) {
          logger.warn(`motion staleness uncomputable for shot ${shot.id}:`, {
            err: error,
          });
        }
      }
    }

    return { thumbnail, visualPrompt, motionPrompt };
  });

/**
 * Get a signed download URL for a shot's video.
 * Uses Content-Disposition: attachment to force browser download.
 */
export const getShotDownloadUrlFn = createServerFn({ method: 'GET' })
  .middleware([shotAccessMiddleware])
  .inputValidator(zodValidator(shotIdInputSchema))
  .handler(async ({ context }) => {
    const { shot } = context;

    if (!shot.videoPath) {
      throw new Error('Shot does not have a video');
    }

    const filename =
      shot.videoPath.split('/').pop() || `scene-${shot.id}_openstory.mp4`;

    const downloadUrl = await getVideoDownloadUrl(
      shot.videoPath,
      filename,
      3600
    );

    return { downloadUrl, filename };
  });
