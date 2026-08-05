/**
 * Scene-script read helpers (#1030).
 *
 * Canonical script lives in `scene_script_versions`; these utilities overlay
 * the selected version onto shot metadata for prompt/staleness paths and
 * compose the sequence-level document from per-scene slices.
 */

import type { Scene } from '@/lib/ai/scene-analysis.schema';
import {
  dbSceneId,
  type DbSceneId,
  type SceneRow,
  type SceneScriptVersion,
  type Shot,
} from '@/lib/db/schema';
import type { Database } from '@/lib/db/client';
import { createSceneScriptVersionsMethods } from '@/lib/db/scoped/scene-script-versions';
import { createScenesMethods } from '@/lib/db/scoped/scenes';
import type { ScopedDb } from '@/lib/db/scoped';

export function overlaySceneScript(
  scene: Scene,
  script: Scene['originalScript'] | null | undefined
): Scene {
  if (!script) return scene;
  return { ...scene, originalScript: script };
}

export function scriptExtract(
  script: Scene['originalScript'] | null | undefined
): string {
  return script?.extract ?? '';
}

export function composeSequenceScript(
  rows: ReadonlyArray<{
    orderIndex: number;
    content: Scene['originalScript'];
  }>
): string {
  return [...rows]
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((row) => row.content.extract)
    .join('\n\n');
}

export function enrichShotWithSceneScript<
  T extends Pick<Shot, 'sceneId' | 'metadata'>,
>(shot: T, scriptBySceneId: ReadonlyMap<string, Scene['originalScript']>): T {
  if (!shot.sceneId || !shot.metadata) return shot;
  const script = scriptBySceneId.get(shot.sceneId);
  if (!script) return shot;
  return {
    ...shot,
    metadata: overlaySceneScript(shot.metadata, script),
  };
}

type SceneScriptSource =
  | Scene['originalScript']
  | null
  | undefined
  | ReadonlyMap<string, Scene['originalScript']>;

/**
 * Resolve canonical scene metadata + script for a shot without mutating it.
 * Accepts either a single selected script or a preloaded per-sequence map.
 */
export function resolveSceneForShot<
  T extends Pick<Shot, 'sceneId' | 'metadata'>,
>(
  shot: T,
  scriptSource: SceneScriptSource
): { scene: Scene | null; script: Scene['originalScript'] | null } {
  if (!shot.metadata) {
    return { scene: null, script: null };
  }
  const script =
    scriptSource instanceof Map
      ? shot.sceneId
        ? (scriptSource.get(shot.sceneId) ?? null)
        : null
      : (scriptSource ?? null);
  return {
    scene: overlaySceneScript(shot.metadata, script ?? undefined),
    script,
  };
}

/** Db-backed variant for single-shot middleware and handlers. */
export async function resolveSceneForShotFromDb(
  shot: Pick<Shot, 'sceneId' | 'metadata'>,
  scopedDb: Pick<ScopedDb, 'sceneScriptVersions'>
): Promise<{ scene: Scene | null; script: Scene['originalScript'] | null }> {
  if (!shot.metadata) {
    return { scene: null, script: null };
  }
  let script: Scene['originalScript'] | null = null;
  if (shot.sceneId) {
    const selected = await scopedDb.sceneScriptVersions.getSelected(
      dbSceneId(shot.sceneId)
    );
    script = selected?.content ?? null;
  }
  return resolveSceneForShot(shot, script);
}

/** Project canonical script onto a shot for client API responses (UI reads metadata). */
export function projectShotForClient<
  T extends Pick<Shot, 'sceneId' | 'metadata'>,
>(shot: T, script: Scene['originalScript'] | null | undefined): T {
  if (!script || !shot.sceneId) return shot;
  return enrichShotWithSceneScript(shot, new Map([[shot.sceneId, script]]));
}

function buildScriptBySceneId(
  sceneRows: ReadonlyArray<SceneRow>,
  versions: ReadonlyMap<DbSceneId, SceneScriptVersion>
): Map<string, Scene['originalScript']> {
  const map = new Map<string, Scene['originalScript']>();
  for (const scene of sceneRows) {
    const version = versions.get(scene.id);
    if (version) {
      map.set(scene.id, version.content);
    } else if (scene.originalScript) {
      map.set(scene.id, scene.originalScript);
    }
  }
  return map;
}

/** Load selected script content keyed by scene id for a sequence. */
export async function loadSelectedScriptsBySequence(
  scopedDb: Pick<ScopedDb, 'scenes' | 'sceneScriptVersions'>,
  sequenceId: string
): Promise<Map<string, Scene['originalScript']>> {
  const [sceneRows, selectedRows] = await Promise.all([
    scopedDb.scenes.listBySequence(sequenceId),
    scopedDb.sceneScriptVersions.listSelectedBySequence(sequenceId),
  ]);
  const versions = new Map(
    selectedRows.map((row) => [row.sceneId, row.version] as const)
  );
  return buildScriptBySceneId(sceneRows, versions);
}

/** Raw-db variant for scoped sub-modules that only hold a `Database` handle. */
export async function loadSelectedScriptsBySequenceFromDb(
  db: Database,
  sequenceId: string
): Promise<Map<string, Scene['originalScript']>> {
  return loadSelectedScriptsBySequence(
    {
      scenes: createScenesMethods(db),
      sceneScriptVersions: createSceneScriptVersionsMethods(db),
    },
    sequenceId
  );
}

/** Compose the full sequence script from selected scene versions. */
export async function composeSequenceScriptFromDb(
  scopedDb: Pick<ScopedDb, 'sceneScriptVersions'>,
  sequenceId: string
): Promise<string> {
  const rows =
    await scopedDb.sceneScriptVersions.listSelectedBySequence(sequenceId);
  return composeSequenceScript(
    rows.map((row) => ({
      orderIndex: row.orderIndex,
      content: row.version.content,
    }))
  );
}
