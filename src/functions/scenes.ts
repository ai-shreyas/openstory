import { computeMotionPromptInputHash } from '@/lib/ai/input-hash';
import { loadNarrowShotPromptContext } from '@/lib/ai/prompt-context';
import type { Scene } from '@/lib/ai/scene-analysis.schema';
import type { ScopedDb } from '@/lib/db/scoped';
import { dbSceneId, type DbSceneId } from '@/lib/db/schema';
import { NotFoundError } from '@/lib/errors';
import {
  composeSequenceScriptFromDb,
  loadSceneContextBySequence,
  resolveSceneForShot,
} from '@/lib/scenes/scene-script';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { sequenceAccessMiddleware } from './middleware';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'serverFn', 'scenes']);

/** Ordered scenes for a sequence (#909 — the editor groups shots under these). */
export const getScenesFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    // Each scene carries its SELECTED script, not the `originalScript` column
    // snapshot — that column is the split-time copy and goes stale on edit.
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
    const currentScript = selected?.content ?? sceneRow.originalScript;
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

      await bootstrapMotionHashesForScene({
        scopedDb,
        sequence,
        sceneId,
        // Hash the PRE-edit scene, so the next read compares the new script
        // against it and flips to 'stale' (#684 parity).
        preEditScript: currentScript,
      });
    }

    const refreshedScript =
      (await scopedDb.sceneScriptVersions.getSelected(sceneId))?.content ??
      currentScript;

    return { sceneId: data.sceneId, script: refreshedScript };
  });

/**
 * Give every shot in the scene a motion-prompt input hash if it is missing one,
 * computed from the scene as it read BEFORE this edit. Without the bootstrap a
 * hand-written motion prompt has nothing to compare against and its staleness
 * stays untracked forever. Per-shot failures are logged, never thrown — a
 * missing hash degrades staleness reporting; it must not fail the user's save.
 */
async function bootstrapMotionHashesForScene({
  scopedDb,
  sequence,
  sceneId,
  preEditScript,
}: {
  scopedDb: ScopedDb;
  sequence: Parameters<typeof loadNarrowShotPromptContext>[0]['sequence'];
  sceneId: DbSceneId;
  preEditScript: Scene['originalScript'];
}): Promise<void> {
  const shots = (await scopedDb.shots.listBySequence(sequence.id)).filter(
    (shot) =>
      shot.sceneId === sceneId &&
      shot.motionPrompt &&
      !shot.motionPromptInputHash
  );
  if (shots.length === 0) return;

  const anchorByShot = await scopedDb.frames.getAnchorsByShots(
    shots.map((shot) => shot.id)
  );
  // The i2v still lives on each anchor's SELECTED version (#1067).
  const selectedByFrame = await scopedDb.frameVariants.getSelectedByFrameIds(
    [...anchorByShot.values()].map((frame) => frame.id)
  );

  const sceneContext = await loadSceneContextBySequence(scopedDb, sequence.id);

  for (const shot of shots) {
    const ctxEntry = shot.sceneId ? sceneContext.get(shot.sceneId) : null;
    if (!ctxEntry) continue;
    // Hash against the script as it was BEFORE the edit.
    const { scene } = resolveSceneForShot(shot, {
      ...ctxEntry,
      script: preEditScript ?? ctxEntry.script,
    });
    if (!scene) continue;
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
        startingFrameImageUrl: (() => {
          const anchor = anchorByShot.get(shot.id);
          return anchor ? (selectedByFrame.get(anchor.id)?.url ?? null) : null;
        })(),
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
