/**
 * Scene↔bible tag reconciliation (#1035).
 *
 * The scenes call and the bibles call run as two independent LLM requests, so
 * `continuity.characterTags` / `environmentTag` / `elementTags` (scenes call)
 * and the bibles' `consistencyTag`s / `token`s can drift ("Jack-denim" vs
 * "jack_denim_weathered") even though both prompts constrain the format hard.
 * Downstream prompt assembly and reference-image binding join on these tags,
 * so after the two results are joined we canonicalize every scene tag onto its
 * fuzzy-matched bible counterpart rather than silently trusting agreement.
 * Tags with no bible match are kept as-is (never invented, never dropped).
 */

import {
  matchCharacterToShotTags,
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

export type TagReconcileStats = {
  rewrittenCharacterTags: number;
  unmatchedCharacterTags: number;
  rewrittenEnvironmentTags: number;
  unmatchedEnvironmentTags: number;
  rewrittenElementTags: number;
  unmatchedElementTags: number;
};

export function reconcileSceneTags(
  scenes: SceneSplittingScene[],
  bibles: Pick<
    SceneSplitBiblesResult,
    'characterBible' | 'locationBible' | 'elementBible'
  >
): { scenes: SceneSplittingScene[]; stats: TagReconcileStats } {
  const stats: TagReconcileStats = {
    rewrittenCharacterTags: 0,
    unmatchedCharacterTags: 0,
    rewrittenEnvironmentTags: 0,
    unmatchedEnvironmentTags: 0,
    rewrittenElementTags: 0,
    unmatchedElementTags: 0,
  };

  const canonicalCharacterTag = (entry: {
    name: string;
    consistencyTag: string;
  }): string => entry.consistencyTag || slugify(entry.name);
  const canonicalLocationTag = (entry: {
    name: string;
    consistencyTag: string;
  }): string => entry.consistencyTag || slugify(entry.name);

  const elementTokens = bibles.elementBible.map((e) => e.token.toUpperCase());

  const reconciled = scenes.map((scene) => {
    const characterTags: string[] = [];
    for (const tag of scene.continuity.characterTags) {
      const entry = bibles.characterBible.find((c) =>
        matchCharacterToShotTags(c, [tag])
      );
      if (!entry) {
        stats.unmatchedCharacterTags++;
        characterTags.push(tag);
        continue;
      }
      const canonical = canonicalCharacterTag(entry);
      if (canonical !== tag) stats.rewrittenCharacterTags++;
      if (!characterTags.includes(canonical)) characterTags.push(canonical);
    }

    let environmentTag = scene.continuity.environmentTag;
    if (environmentTag) {
      const [match] = matchLocationsToScene(
        bibles.locationBible,
        environmentTag,
        scene.metadata.location
      );
      if (match) {
        const canonical = canonicalLocationTag(match);
        if (canonical !== environmentTag) stats.rewrittenEnvironmentTags++;
        environmentTag = canonical;
      } else {
        stats.unmatchedEnvironmentTags++;
      }
    }

    const elementTags = scene.continuity.elementTags?.map((tag) => {
      const upper = tag.toUpperCase();
      const exact = elementTokens.find((t) => t === upper);
      if (exact) {
        if (exact !== tag) stats.rewrittenElementTags++;
        return exact;
      }
      // Substring either way catches invented-token drift between the two
      // calls ("LIPSTICK" vs "CORAL_LIPSTICK").
      const fuzzy = elementTokens.find(
        (t) => t.includes(upper) || upper.includes(t)
      );
      if (fuzzy) {
        stats.rewrittenElementTags++;
        return fuzzy;
      }
      stats.unmatchedElementTags++;
      return tag;
    });

    return {
      ...scene,
      continuity: {
        ...scene.continuity,
        characterTags,
        environmentTag,
        elementTags: elementTags ?? scene.continuity.elementTags,
      },
    };
  });

  return { scenes: reconciled, stats };
}
