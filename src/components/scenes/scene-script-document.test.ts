import { describe, expect, it } from 'vitest';
import {
  buildScriptBlocks,
  type ScriptBlockScene,
  type ScriptBlockShot,
} from './scene-script-document';
import { dbSceneId } from '@/lib/db/schema';

function scene(
  id: string,
  orderIndex: number,
  analysisExtract?: string
): ScriptBlockScene {
  return {
    id: dbSceneId(id),
    orderIndex,
    title: null,
    originalScript: analysisExtract
      ? { extract: analysisExtract, dialogue: [] }
      : null,
  };
}

function shot(sceneId: string | null, extract: string): ScriptBlockShot {
  return {
    sceneId,
    metadata: {
      sceneId: 'scene-1',
      sceneNumber: 1,
      originalScript: { extract, dialogue: [] },
      metadata: {
        title: 'A title',
        durationSeconds: 5,
        location: 'Kitchen',
        timeOfDay: 'DAY',
        storyBeat: 'setup',
      },
    },
  };
}

describe('buildScriptBlocks', () => {
  it('orders blocks by scene orderIndex and numbers them 1-based', () => {
    const blocks = buildScriptBlocks(
      [scene('s2', 1), scene('s1', 0), scene('s3', 2)],
      []
    );

    expect(blocks.map((b) => b.sceneId)).toEqual(['s1', 's2', 's3']);
    expect(blocks.map((b) => b.sceneNumber)).toEqual([1, 2, 3]);
  });

  it("prefers the shot's overlaid script over the scene row's analysis copy", () => {
    // getShotsFn overlays the SELECTED script version onto shot metadata
    // (#1030); the scene row still holds the original analysis text, so an
    // edited scene must read from the shot or the document shows stale text.
    const blocks = buildScriptBlocks(
      [scene('s1', 0, 'Analysis copy.')],
      [shot('s1', 'Edited copy.')]
    );

    expect(blocks[0]?.extract).toBe('Edited copy.');
  });

  it("falls back to the scene row when the scene's shots haven't loaded", () => {
    const blocks = buildScriptBlocks([scene('s1', 0, 'Analysis copy.')], []);

    expect(blocks[0]?.extract).toBe('Analysis copy.');
  });

  it('takes the first shot of a multi-shot scene — they share one script', () => {
    const blocks = buildScriptBlocks(
      [scene('s1', 0)],
      [shot('s1', 'Scene text.'), shot('s1', 'Scene text.')]
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.extract).toBe('Scene text.');
  });

  it('ignores shots not linked to a scene', () => {
    const blocks = buildScriptBlocks(
      [scene('s1', 0)],
      [shot(null, 'Orphan text.')]
    );

    expect(blocks[0]?.extract).toBe('');
  });

  it('renders an empty string rather than dropping a scene with no script', () => {
    const blocks = buildScriptBlocks([scene('s1', 0)], []);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.extract).toBe('');
  });
});
