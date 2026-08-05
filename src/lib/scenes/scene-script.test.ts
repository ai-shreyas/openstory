import { describe, expect, it } from 'vitest';
import {
  composeSequenceScript,
  enrichShotWithSceneScript,
  overlaySceneScript,
  projectShotForClient,
  resolveSceneForShot,
} from './scene-script';
import type { Scene } from '@/lib/ai/scene-analysis.schema';

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

describe('resolveSceneForShot', () => {
  it('returns overlaid scene and script without mutating the shot', () => {
    const shot = {
      id: 'shot-1',
      sceneId: 'scene-row-1',
      metadata: sceneFixture({
        originalScript: { extract: 'Legacy shot copy.', dialogue: [] },
      }),
    } as const;
    const { scene, script } = resolveSceneForShot(shot, {
      extract: 'Canonical scene copy.',
      dialogue: [],
    });
    expect(script?.extract).toBe('Canonical scene copy.');
    expect(scene?.originalScript.extract).toBe('Canonical scene copy.');
    expect(shot.metadata.originalScript.extract).toBe('Legacy shot copy.');
  });

  it('resolves from a preloaded script map', () => {
    const shot = {
      id: 'shot-1',
      sceneId: 'scene-row-1',
      metadata: sceneFixture(),
    } as const;
    const { script } = resolveSceneForShot(
      shot,
      new Map([['scene-row-1', { extract: 'From map.', dialogue: [] }]])
    );
    expect(script?.extract).toBe('From map.');
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
        ['scene-row-1', { extract: 'Canonical scene copy.', dialogue: [] }],
      ])
    );
    expect(enriched.metadata?.originalScript.extract).toBe(
      'Canonical scene copy.'
    );
  });
});
