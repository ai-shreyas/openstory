import { describe, expect, it } from 'vitest';
import {
  composeSequenceScript,
  enrichShotWithSceneScript,
  overlaySceneScript,
  projectShotForClient,
  resolveSceneForShot,
} from './scene-script';
import type { Scene } from '@/lib/ai/scene-analysis.schema';
import { dbSceneId, type SceneRow } from '@/lib/db/schema';

const sceneFixture = (overrides: Partial<Scene> = {}): Scene => ({
  sceneId: 'scene-1',
  sceneNumber: 1,
  originalScript: { extract: 'INT. OFFICE - DAY', dialogue: [] },
  metadata: {
    title: 'Office',
    location: 'Office',
    timeOfDay: 'DAY',
    storyBeat: 'setup',
    durationSeconds: 5,
  },
  continuity: {
    characterTags: [],
    environmentTag: '',
    elementTags: [],
    colorPalette: '',
    lightingSetup: '',
    styleTag: '',
  },
  ...overrides,
});

describe('composeSequenceScript', () => {
  it('joins extracts in orderIndex order', () => {
    const composed = composeSequenceScript([
      {
        orderIndex: 1,
        content: { extract: 'Scene two.', dialogue: [] },
      },
      {
        orderIndex: 0,
        content: { extract: 'Scene one.', dialogue: [] },
      },
    ]);
    expect(composed).toBe('Scene one.\n\nScene two.');
  });
});

describe('overlaySceneScript', () => {
  it('replaces originalScript on the scene object', () => {
    const scene = sceneFixture();
    const next = overlaySceneScript(scene, {
      extract: 'Updated.',
      dialogue: [],
    });
    expect(next.originalScript.extract).toBe('Updated.');
  });
});

const sceneRowFixture = (overrides: Partial<SceneRow> = {}): SceneRow => ({
  id: dbSceneId('scene-row-1'),
  sequenceId: 'seq-1',
  orderIndex: 0,
  location: 'Office',
  timeOfDay: 'DAY',
  storyBeat: 'setup',
  title: 'Office',
  continuity: null,
  musicDesign: null,
  originalScript: { extract: 'Scene row copy.', dialogue: [] },
  selectedScriptVersionId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('resolveSceneForShot', () => {
  const shot = { id: 'shot-1', sceneId: 'scene-row-1', durationMs: 5000 };

  it('composes the scene from the scene row, not the shot', () => {
    const { scene, script } = resolveSceneForShot(shot, {
      scene: sceneRowFixture(),
      script: { extract: 'Canonical scene copy.', dialogue: [] },
    });
    expect(script?.extract).toBe('Canonical scene copy.');
    expect(scene?.originalScript.extract).toBe('Canonical scene copy.');
    expect(scene?.metadata?.title).toBe('Office');
    expect(scene?.sceneId).toBe('scene-row-1');
    expect(scene?.sceneNumber).toBe(1);
  });

  it('derives durationSeconds from the shot, not a stored copy', () => {
    const { scene } = resolveSceneForShot(
      { ...shot, durationMs: 7500 },
      { scene: sceneRowFixture(), script: null }
    );
    expect(scene?.metadata?.durationSeconds).toBe(7.5);
  });

  it('resolves from a preloaded map', () => {
    const { script } = resolveSceneForShot(
      shot,
      new Map([
        [
          'scene-row-1',
          {
            scene: sceneRowFixture(),
            script: { extract: 'From map.', dialogue: [] },
          },
        ],
      ])
    );
    expect(script?.extract).toBe('From map.');
  });

  it('resolves null for a shot with no scene', () => {
    expect(resolveSceneForShot({ ...shot, sceneId: null }, new Map())).toEqual({
      scene: null,
      script: null,
    });
  });
});

describe('projectShotForClient', () => {
  it('projects canonical script onto shot metadata for API responses', () => {
    const shot = {
      id: 'shot-1',
      sceneId: 'scene-row-1',
      metadata: sceneFixture({
        originalScript: { extract: 'Legacy.', dialogue: [] },
      }),
    } as const;
    const projected = projectShotForClient(shot, {
      extract: 'For UI.',
      dialogue: [],
    });
    expect(projected.metadata?.originalScript.extract).toBe('For UI.');
    expect(shot.metadata.originalScript.extract).toBe('Legacy.');
  });
});

describe('enrichShotWithSceneScript', () => {
  it('overlays selected script onto shot metadata', () => {
    const shot = {
      id: 'shot-1',
      sceneId: 'scene-row-1',
      metadata: sceneFixture({
        originalScript: { extract: 'Legacy shot copy.', dialogue: [] },
      }),
    } as const;
    const enriched = enrichShotWithSceneScript(
      shot,
      new Map([
        [
          'scene-row-1',
          {
            scene: sceneRowFixture(),
            script: { extract: 'Canonical scene copy.', dialogue: [] },
          },
        ],
      ])
    );
    expect(enriched.metadata?.originalScript.extract).toBe(
      'Canonical scene copy.'
    );
  });
});
