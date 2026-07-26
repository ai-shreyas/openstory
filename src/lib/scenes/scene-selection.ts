import type { ShotWithImage } from '@/lib/shots/shot-with-image';
import { z } from 'zod';

/** URL-synced editor selection — empty means whole sequence. */
export type SceneSelection = {
  sceneIds: string[];
  shotId?: string;
};

export type SelectionScope = 'sequence' | 'scenes' | 'shot';

/** Union of continuity tags across shots in the current selection scope. */
export type SelectionTags = {
  characterTags: string[];
  environmentTags: string[];
  elementTags: string[];
  /** Script extracts from scoped shots — used for element token matching. */
  scriptExtracts: string[];
};

/**
 * The inspector facets/tabs — one shared token set, so the URL `facet` param
 * and the inspector's tab values never drift apart.
 */
export const SCENE_FACETS = [
  'cast',
  'location',
  'elements',
  'music',
  'script',
  'scene-variants',
  'image-prompt',
  'motion-prompt',
] as const;

export type SceneFacet = (typeof SCENE_FACETS)[number];

export const scenesSearchSchema = z.object({
  scenes: z.string().optional(),
  shot: z.string().optional(),
  facet: z.enum(SCENE_FACETS).optional(),
});

export type ScenesSearch = z.infer<typeof scenesSearchSchema>;

export function parseSelectionFromSearch(search: {
  scenes?: string;
  shot?: string;
}): SceneSelection {
  // Shot and scene selection are mutually exclusive; a URL carrying both
  // (hand-edited or stale link) normalizes to the shot so every consumer
  // sees the same state the transition functions produce.
  if (search.shot) {
    return { sceneIds: [], shotId: search.shot };
  }
  return {
    sceneIds: search.scenes
      ? search.scenes.split(',').filter((id) => id.length > 0)
      : [],
  };
}

export function selectionToSearchParams(
  selection: SceneSelection,
  facet?: SceneFacet
): ScenesSearch {
  const params: ScenesSearch = {};
  if (selection.shotId) {
    params.shot = selection.shotId;
  } else if (selection.sceneIds.length > 0) {
    params.scenes = selection.sceneIds.join(',');
  }
  if (facet) params.facet = facet;
  return params;
}

function isSelectionEmpty(selection: SceneSelection): boolean {
  return selection.sceneIds.length === 0 && !selection.shotId;
}

export function selectionScope(selection: SceneSelection): SelectionScope {
  if (selection.shotId) return 'shot';
  if (selection.sceneIds.length > 0) return 'scenes';
  return 'sequence';
}

/**
 * Derive facet filter tags from selection. Returns `null` when nothing is
 * selected (whole sequence) so facets show the full library with no filter.
 */
export function selectionTags(
  selection: SceneSelection,
  shots: ShotWithImage[]
): SelectionTags | null {
  if (isSelectionEmpty(selection)) return null;

  let scopedShots: ShotWithImage[];
  if (selection.shotId) {
    const shot = shots.find((s) => s.id === selection.shotId);
    scopedShots = shot ? [shot] : [];
  } else {
    const sceneIdSet = new Set(selection.sceneIds);
    scopedShots = shots.filter(
      (s) => s.sceneId != null && sceneIdSet.has(s.sceneId)
    );
  }

  const characterTags = new Set<string>();
  const environmentTags = new Set<string>();
  const elementTags = new Set<string>();
  const scriptExtracts: string[] = [];

  for (const shot of scopedShots) {
    const continuity = shot.metadata?.continuity;
    for (const tag of continuity?.characterTags ?? []) {
      characterTags.add(tag);
    }
    const envTag = continuity?.environmentTag;
    if (envTag) environmentTags.add(envTag);
    for (const tag of continuity?.elementTags ?? []) {
      elementTags.add(tag);
    }
    const extract =
      shot.metadata?.originalScript?.extract ?? shot.description ?? '';
    if (extract) scriptExtracts.push(extract);
  }

  return {
    characterTags: [...characterTags],
    environmentTags: [...environmentTags],
    elementTags: [...elementTags],
    scriptExtracts,
  };
}

/** Shots that belong to the current canvas playback scope. */
export function selectionShots(
  selection: SceneSelection,
  shots: ShotWithImage[]
): ShotWithImage[] {
  if (selection.shotId) {
    const shot = shots.find((s) => s.id === selection.shotId);
    return shot ? [shot] : [];
  }
  if (selection.sceneIds.length > 0) {
    const sceneIdSet = new Set(selection.sceneIds);
    return shots.filter((s) => s.sceneId != null && sceneIdSet.has(s.sceneId));
  }
  return shots;
}

export function toggleSceneInSelection(
  selection: SceneSelection,
  sceneId: string,
  additive: boolean
): SceneSelection {
  if (selection.shotId) {
    return additive
      ? { sceneIds: [sceneId], shotId: undefined }
      : { sceneIds: [sceneId] };
  }
  const has = selection.sceneIds.includes(sceneId);
  if (additive) {
    return {
      sceneIds: has
        ? selection.sceneIds.filter((id) => id !== sceneId)
        : [...selection.sceneIds, sceneId],
    };
  }
  return has && selection.sceneIds.length === 1
    ? { sceneIds: [] }
    : { sceneIds: [sceneId] };
}

export function selectShot(shotId: string): SceneSelection {
  return { sceneIds: [], shotId };
}

export function clearSelection(): SceneSelection {
  return { sceneIds: [] };
}

/**
 * Walk up one selection level: shot → parent scene → whole sequence.
 * Returns `null` when already at sequence (nothing to ascend). Used by Escape.
 */
export function ascendSelection(
  selection: SceneSelection,
  shots: ReadonlyArray<{ id: string; sceneId: string | null }>
): SceneSelection | null {
  if (selection.shotId) {
    const shot = shots.find((s) => s.id === selection.shotId);
    const sceneId = shot?.sceneId;
    if (sceneId) return { sceneIds: [sceneId] };
    return clearSelection();
  }
  if (selection.sceneIds.length > 0) {
    return clearSelection();
  }
  return null;
}
