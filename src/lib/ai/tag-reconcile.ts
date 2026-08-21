/**
 * Scene↔bible membership (#1218).
 *
 * Scene-split no longer asks the LLM for continuity tags. After the bibles
 * call joins, each scene's verbatim slice is scanned for bible names /
 * tokens and the matching `consistencyTag`s are stamped on. Downstream
 * prompt assembly and reference-image binding join on these tags.
 */

import {
  matchElementsToScene,
  matchLocationsToScene,
} from '@/lib/workflows/scene-matching';
import type { SceneSplitBiblesResult } from './response-schemas';
import type { SceneSplittingScene } from './streaming-scene-parser';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join('_');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wholeWord(haystackUpper: string, needleUpper: string): boolean {
  if (needleUpper.length === 0) return false;
  const re = new RegExp(
    `(?:^|[^A-Z0-9_])${escapeRegex(needleUpper)}(?:[^A-Z0-9_]|$)`
  );
  return re.test(haystackUpper);
}

function characterMentioned(extract: string, name: string): boolean {
  const haystack = extract.toUpperCase();
  const nameUpper = name.toUpperCase().trim();
  if (nameUpper.length < 2) return false;
  if (wholeWord(haystack, nameUpper)) return true;
  const first = nameUpper.split(/\s+/)[0];
  return Boolean(first && first.length >= 3 && wholeWord(haystack, first));
}

export type TagReconcileStats = {
  assignedCharacterTags: number;
  assignedEnvironmentTags: number;
  assignedElementTags: number;
};

export function reconcileSceneTags(
  scenes: SceneSplittingScene[],
  bibles: Pick<
    SceneSplitBiblesResult,
    'characterBible' | 'locationBible' | 'elementBible'
  >
): { scenes: SceneSplittingScene[]; stats: TagReconcileStats } {
  const stats: TagReconcileStats = {
    assignedCharacterTags: 0,
    assignedEnvironmentTags: 0,
    assignedElementTags: 0,
  };

  const canonicalCharacterTag = (entry: {
    name: string;
    consistencyTag: string;
  }): string => entry.consistencyTag || slugify(entry.name);
  const canonicalLocationTag = (entry: {
    name: string;
    consistencyTag: string;
  }): string => entry.consistencyTag || slugify(entry.name);

  const reconciled = scenes.map((scene) => {
    const extract = scene.originalScript.extract;
    const characterTags: string[] = [];
    for (const entry of bibles.characterBible) {
      if (!characterMentioned(extract, entry.name)) continue;
      const tag = canonicalCharacterTag(entry);
      if (!characterTags.includes(tag)) {
        characterTags.push(tag);
        stats.assignedCharacterTags++;
      }
    }

    const [locationMatch] = matchLocationsToScene(
      bibles.locationBible,
      '',
      scene.metadata.location
    );
    const environmentTag = locationMatch
      ? canonicalLocationTag(locationMatch)
      : '';
    if (environmentTag) stats.assignedEnvironmentTags++;

    const matchedElements = matchElementsToScene(
      bibles.elementBible,
      [],
      extract
    );
    const elementTags =
      matchedElements.length > 0
        ? matchedElements.map((e) => e.token.toUpperCase())
        : null;
    if (elementTags) stats.assignedElementTags += elementTags.length;

    return {
      ...scene,
      continuity: {
        ...scene.continuity,
        characterTags,
        environmentTag,
        elementTags,
        colorPalette:
          scene.continuity.colorPalette || locationMatch?.colorPalette || '',
        lightingSetup:
          scene.continuity.lightingSetup || locationMatch?.lightingSetup || '',
      },
    };
  });

  return { scenes: reconciled, stats };
}
