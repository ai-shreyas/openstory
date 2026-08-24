import type { ShotStaleness } from '@/hooks/use-shot-staleness';
import { describe, expect, it } from 'vitest';
import { describeCauses, describeLevel, shotsLabel } from './update-all-dialog';

const shot = (causes: string[]): ShotStaleness => ({
  thumbnail: 'stale',
  visualPrompt: 'fresh',
  motionPrompt: 'fresh',
  causes,
});

describe('describeCauses', () => {
  it('dedupes causes across shots', () => {
    expect(
      describeCauses([shot(['Script', 'Character "Woman"']), shot(['Script'])])
    ).toBe('Changed: Script, Character "Woman"');
  });
  it('null when nothing could be named', () => {
    expect(describeCauses([shot([])])).toBeNull();
  });
});

describe('shotsLabel', () => {
  const numbers = new Map([
    ['a', 2],
    ['b', 3],
    ['c', 4],
  ]);
  it('lists shot numbers', () => {
    expect(shotsLabel(['c', 'a', 'b'], numbers, false)).toBe('shots 2, 3 & 4');
    expect(shotsLabel(['a'], numbers, false)).toBe('shot 2');
  });
  it('shot scope reads "this shot"', () => {
    expect(shotsLabel(['a'], numbers, true)).toBe('this shot');
  });
  it('falls back to a count without numbering', () => {
    expect(shotsLabel(['x', 'y'], undefined, false)).toBe('2 shots');
  });
});

describe('describeLevel', () => {
  const numbers = new Map([
    ['a', 2],
    ['b', 3],
  ]);
  const preview = {
    visualPromptShotIds: ['a', 'b'],
    motionPromptShotIds: ['b'],
    imageShotIds: ['a', 'b'],
    videoShotIds: [],
    musicPrompt: true,
    musicTrack: false,
    costByDepth: { prompts: null, images: null, video: null, music: null },
  };
  it('names each level concretely', () => {
    expect(describeLevel('prompts', preview, numbers, false)).toBe(
      'Image prompts for shots 2 & 3 · Motion prompts for shot 3'
    );
    expect(describeLevel('images', preview, numbers, false)).toBe(
      '+ Images for shots 2 & 3'
    );
    expect(describeLevel('video', preview, numbers, false)).toBe(
      '+ No videos affected'
    );
    expect(describeLevel('music', preview, numbers, false)).toBe(
      '+ Music prompt'
    );
  });
});
