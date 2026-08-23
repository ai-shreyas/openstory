import type { ShotStaleness } from '@/hooks/use-shot-staleness';
import { describe, expect, it } from 'vitest';
import { describeStaleShots } from './update-all-dialog';

const shot = (o: Partial<ShotStaleness>): ShotStaleness => ({
  thumbnail: 'fresh',
  visualPrompt: 'fresh',
  motionPrompt: 'fresh',
  ...o,
});

describe('describeStaleShots', () => {
  it('names each stale artifact once across shots', () => {
    expect(
      describeStaleShots([
        shot({ visualPrompt: 'stale', thumbnail: 'stale' }),
        shot({ motionPrompt: 'stale' }),
        shot({ visualPrompt: 'stale' }),
      ])
    ).toBe(
      '3 shots have an out-of-date visual prompt, motion prompt and image.'
    );
  });
  it('singular shot', () => {
    expect(describeStaleShots([shot({ thumbnail: 'stale' })])).toBe(
      'This shot has an out-of-date image.'
    );
  });
});
