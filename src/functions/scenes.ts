import { dbSceneId } from '@/lib/db/schema';
import { NotFoundError } from '@/lib/errors';
import {
  composeSequenceScriptFromDb,
  loadSceneContextBySequence,
} from '@/lib/scenes/scene-script';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { sequenceAccessMiddleware } from './middleware';

/** Ordered scenes for a sequence (#909 — the editor groups shots under these). */
export const getScenesFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    // Each scene carries its SELECTED script — the only place a script lives.
    const ctx = await loadSceneContextBySequence(
      context.scopedDb,
      context.sequence.id
    );
    return [...ctx.values()]
      .map(({ scene, script }) => ({ ...scene, script }))
      .sort((a, b) => a.orderIndex - b.orderIndex);
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
  sceneId: ulidSchema,
  extract: z.string(),
});

/**
 * Edit a scene's script by appending a `scene_script_versions` row and
 * repointing `selectedScriptVersionId` (#1030). Prompt-input-hash staleness
 * picks up the new `originalScript` automatically; no sequence fork.
 *
 * Addressed by **sceneId**, matching where the script is stored. It used to
 * take a `shotId` and derive `shot.sceneId`, which read as a per-shot edit
 * while writing scene-wide — harmless while every scene had one shot, actively
 * misleading once a scene has several (#910): editing "this shot's script"
 * rewrites the script of all of them. The scene is the unit.
 *
 * Duration is NOT edited here — it is a video parameter, not a prompt driver
 * (see `updateShotDurationFn`), and it lives per-shot while the script lives
 * per-scene.
 */
export const updateSceneScriptFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(zodValidator(updateSceneScriptSchema))
  .handler(async ({ data, context }) => {
    const { sequence, scopedDb, user } = context;

    const sceneId = dbSceneId(data.sceneId);
    const sceneRow = await scopedDb.scenes.getById(sceneId);
    if (!sceneRow || sceneRow.sequenceId !== sequence.id) {
      throw new NotFoundError('Scene not found in this sequence');
    }

    const selected = await scopedDb.sceneScriptVersions.getSelected(sceneId);
    const currentScript = selected?.content;
    if (!currentScript) {
      throw new Error('Scene has no script to edit');
    }
    const scriptChanged = data.extract !== currentScript.extract;

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
    }

    const refreshedScript =
      (await scopedDb.sceneScriptVersions.getSelected(sceneId))?.content ??
      currentScript;

    return { sceneId: data.sceneId, script: refreshedScript };
  });
