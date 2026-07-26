import { computeMotionPromptInputHash } from '@/lib/ai/input-hash';
import { loadNarrowShotPromptContext } from '@/lib/ai/prompt-context';
import { dbSceneId } from '@/lib/db/schema';
import {
  composeSequenceScriptFromDb,
  projectShotForClient,
} from '@/lib/scenes/scene-script';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { sequenceAccessMiddleware, shotAccessMiddleware } from './middleware';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'serverFn', 'scenes']);

/** Ordered scenes for a sequence (#909 — the editor groups shots under these). */
export const getScenesFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.scenes.listBySequence(context.sequence.id);
  });

// NOTE: there is no `updateSceneModelFn` (#1066). A scene has no model of its
// own — model identity belongs to the version row that recorded the generation
// (`frame_variants.model` / `video_variants.model`). Picking a model in the
// editor is a per-request choice that becomes durable when the version it
// produces is selected; see `@/lib/ai/resolve-asset-models`.

/** Composed sequence script from selected scene versions (#1030). */
export const getComposedScriptFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    const composed = await composeSequenceScriptFromDb(
      context.scopedDb,
      context.sequence.id
    );
    return { script: composed };
  });

const updateSceneScriptSchema = z.object({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
  extract: z.string(),
  durationSeconds: z.number().positive().optional(),
});

/**
 * Edit a scene's script by appending a `scene_script_versions` row and
 * repointing `selectedScriptVersionId` (#1030). Prompt-input-hash staleness
 * picks up the new `originalScript` automatically; no sequence fork.
 */
export const updateSceneScriptFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .inputValidator(zodValidator(updateSceneScriptSchema))
  .handler(async ({ data, context }) => {
    const { shot, frame, sequence, scopedDb, user, scene, script } = context;
    if (!shot.sceneId || !scene) {
      throw new Error('Shot is not linked to a scene with metadata');
    }

    const sceneId = dbSceneId(shot.sceneId);
    const selected = await scopedDb.sceneScriptVersions.getSelected(sceneId);
    const currentScript = selected?.content ?? script ?? scene.originalScript;
    const oldExtract = currentScript.extract;
    const scriptChanged = data.extract !== oldExtract;

    if (scriptChanged) {
      await scopedDb.sceneScriptVersions.write({
        sceneId,
        content: {
          ...currentScript,
          extract: data.extract,
          dialogue: [],
        },
        source: 'edit',
        createdBy: user.id,
      });

      // Bootstrap a missing motion prompt hash from the pre-edit scene so
      // staleness can flip to 'stale' on the next read (#684 parity).
      if (shot.motionPrompt && !shot.motionPromptInputHash) {
        try {
          const ctx = await loadNarrowShotPromptContext({
            scopedDb,
            sequence: {
              id: sequence.id,
              styleId: sequence.styleId,
              aspectRatio: sequence.aspectRatio,
              analysisModel: sequence.analysisModel,
            },
            scene,
            startingFrameImageUrl: frame.imageUrl,
          });
          await scopedDb.shots.update(shot.id, {
            motionPromptInputHash: await computeMotionPromptInputHash(ctx),
          });
        } catch (err) {
          logger.warn(
            `Could not bootstrap motion hash for shot ${shot.id}; staleness will remain untracked for this prompt`,
            { err }
          );
        }
      }
    }

    const shotPatch: Parameters<typeof scopedDb.shots.update>[1] = {};
    if (data.durationSeconds !== undefined) {
      shotPatch.durationMs = Math.round(data.durationSeconds * 1000);
      shotPatch.metadata = {
        ...scene,
        metadata: {
          ...(scene.metadata ?? {
            title: '',
            location: '',
            timeOfDay: '',
            storyBeat: '',
          }),
          durationSeconds: data.durationSeconds,
        },
      };
    }

    const updatedShot =
      Object.keys(shotPatch).length > 0
        ? ((await scopedDb.shots.update(shot.id, shotPatch)) ?? shot)
        : shot;

    const refreshedScript =
      (await scopedDb.sceneScriptVersions.getSelected(sceneId))?.content ??
      currentScript;

    return projectShotForClient(updatedShot, refreshedScript);
  });
