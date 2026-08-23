import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reconstructRecordedFalEditPrompts } from './recorded-e2e-fal-prompts';

const FAL_DIR = resolve(
  import.meta.dirname,
  '../../../e2e/fixtures/recorded/fal/xai-grok-imagine-image-quality-edit'
);

describe('reconstructRecordedFalEditPrompts', () => {
  it('matches recorded grok quality/edit userMessages (aimock lockstep)', () => {
    const recorded = new Set(
      readdirSync(FAL_DIR)
        .filter((name) => name.endsWith('.json'))
        .map((name) => {
          const data: {
            fixtures: Array<{ match: { userMessage: string } }>;
          } = JSON.parse(readFileSync(resolve(FAL_DIR, name), 'utf8'));
          return data.fixtures[0]?.match.userMessage ?? '';
        })
    );
    const live = reconstructRecordedFalEditPrompts();
    const missing = live.filter((p) => !recorded.has(p.prompt));
    expect(missing).toEqual([]);
  });
});
