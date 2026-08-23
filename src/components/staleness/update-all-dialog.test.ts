import type { ShotStaleness } from '@/hooks/use-shot-staleness';
import { describe, expect, it } from 'vitest';
import { describeCauses } from './update-all-dialog';

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
