/**
 * Storyboard HTTP triggers must hold a run envelope (#1310), not a read-only
 * requireCredits, and put reservationId on the trigger payload.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const STORYBOARD_TRIGGERS = [
  'src/lib/sequences/create-sequences.ts',
  'src/functions/sequences.ts',
  'src/functions/shot-image.ts',
  'src/lib/sequences/smart-retry.ts',
] as const;

describe('storyboard envelope wiring', () => {
  test.each(STORYBOARD_TRIGGERS)(
    '%s holds with reserveRunCredits and threads reservationId',
    (file) => {
      const source = readFileSync(file, 'utf8');
      expect(source).toMatch(/reserveRunCredits\s*\(/);
      expect(source).toMatch(/reservationId/);
      expect(source).toMatch(/triggerStoryboard/);
    }
  );

  test('analyze-script grows or stops before spawning shot-images', () => {
    const source = readFileSync(
      'src/lib/workflows/analyze-script-workflow.ts',
      'utf8'
    );
    expect(source).toMatch(/gateStoryboardRenders/);
    expect(source).toMatch(/spawn-shot-images/);
    expect(source.indexOf('gateStoryboardRenders')).toBeLessThan(
      source.indexOf('spawn-shot-images')
    );
  });
});
