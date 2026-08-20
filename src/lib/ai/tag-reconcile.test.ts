import { describe, expect, it } from 'vitest';
import type { SceneSplittingScene } from './streaming-scene-parser';
import { reconcileSceneTags } from './tag-reconcile';

function makeScene(
  continuity: Partial<SceneSplittingScene['continuity']>
): SceneSplittingScene {
  return {
    sceneId: 'scene-1',
    sceneNumber: 1,
    originalScript: { extract: 'JACK enters.', dialogue: [] },
    metadata: {
      title: 'Test',
      durationSeconds: 3,
      location: 'INT. OFFICE - DAY',
      timeOfDay: 'day',
      storyBeat: '',
    },
    continuity: {
      characterTags: [],
      environmentTag: '',
      elementTags: null,
      colorPalette: '',
      lightingSetup: '',
      styleTag: '',
      ...continuity,
    },
  };
}

const characterBible = [
  {
    characterId: 'char_001',
    name: 'JACK',
    age: '30s',
    gender: 'male',
    ethnicity: '',
    physicalDescription: '',
    standardClothing: '',
    distinguishingFeatures: '',
    consistencyTag: 'jack_denim_weathered',
  },
];

const locationBible = [
  {
    locationId: 'loc_001',
    name: 'INT. OFFICE - DAY',
    type: 'interior' as const,
    timeOfDay: 'day',
    description: '',
    architecturalStyle: '',
    keyFeatures: '',
    colorPalette: '',
    lightingSetup: '',
    ambiance: '',
    consistencyTag: 'office_modern_steel',
    firstMention: {
      sceneId: 'scene-1',
      text: 'INT. OFFICE - DAY',
      lineNumber: 1,
    },
  },
];

const elementBible = [
  {
    token: 'CORAL_LIPSTICK',
    description: 'a lipstick',
    consistencyTag: 'coral-lipstick',
    firstMention: { sceneId: 'scene-1', text: 'the lipstick', lineNumber: 3 },
  },
];

describe('reconcileSceneTags', () => {
  it('canonicalizes drifted character tags onto the bible consistencyTag', () => {
    const { scenes, stats } = reconcileSceneTags(
      [makeScene({ characterTags: ['jack_office_morning'] })],
      { characterBible, locationBible: [], elementBible: [] }
    );
    expect(scenes[0]?.continuity.characterTags).toEqual([
      'jack_denim_weathered',
    ]);
    expect(stats.rewrittenCharacterTags).toBe(1);
  });

  it('keeps unmatched character tags rather than dropping or inventing', () => {
    const { scenes, stats } = reconcileSceneTags(
      [makeScene({ characterTags: ['mystery_stranger'] })],
      { characterBible, locationBible: [], elementBible: [] }
    );
    expect(scenes[0]?.continuity.characterTags).toEqual(['mystery_stranger']);
    expect(stats.unmatchedCharacterTags).toBe(1);
  });

  it('dedupes two scene tags that resolve to the same bible character', () => {
    const { scenes } = reconcileSceneTags(
      [makeScene({ characterTags: ['jack', 'jack_denim'] })],
      { characterBible, locationBible: [], elementBible: [] }
    );
    expect(scenes[0]?.continuity.characterTags).toEqual([
      'jack_denim_weathered',
    ]);
  });

  it('canonicalizes the environment tag onto the location bible', () => {
    const { scenes, stats } = reconcileSceneTags(
      [makeScene({ environmentTag: 'office_interior' })],
      { characterBible: [], locationBible, elementBible: [] }
    );
    expect(scenes[0]?.continuity.environmentTag).toBe('office_modern_steel');
    expect(stats.rewrittenEnvironmentTags).toBe(1);
  });

  it('leaves an empty environment tag alone', () => {
    const { scenes, stats } = reconcileSceneTags(
      [makeScene({ environmentTag: '' })],
      { characterBible: [], locationBible, elementBible: [] }
    );
    expect(scenes[0]?.continuity.environmentTag).toBe('');
    expect(stats.unmatchedEnvironmentTags).toBe(0);
  });

  it('canonicalizes element tags onto bible tokens (substring drift)', () => {
    const { scenes, stats } = reconcileSceneTags(
      [makeScene({ elementTags: ['LIPSTICK'] })],
      { characterBible: [], locationBible: [], elementBible }
    );
    expect(scenes[0]?.continuity.elementTags).toEqual(['CORAL_LIPSTICK']);
    expect(stats.rewrittenElementTags).toBe(1);
  });

  it('keeps null elementTags as null', () => {
    const { scenes } = reconcileSceneTags([makeScene({ elementTags: null })], {
      characterBible: [],
      locationBible: [],
      elementBible,
    });
    expect(scenes[0]?.continuity.elementTags).toBeNull();
  });
});
