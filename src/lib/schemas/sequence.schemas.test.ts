import { describe, expect, it } from 'vitest';
import { createSequenceSchema } from './sequence.schemas';

describe('createSequenceSchema', () => {
  it('rejects music without motion', () => {
    const result = createSequenceSchema.safeParse({
      script: 'A valid length script here.',
      styleId: 'style_1',
      autoGenerateMotion: false,
      autoGenerateMusic: true,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (i) => i.path[0] === 'autoGenerateMusic'
      );
      expect(issue?.message).toContain('requires motion');
    }
  });

  it('accepts music when motion is enabled', () => {
    const result = createSequenceSchema.safeParse({
      script: 'A valid length script here.',
      styleId: 'style_1',
      aspectRatio: '16:9',
      autoGenerateMotion: true,
      autoGenerateMusic: true,
    });

    expect(result.success).toBe(true);
  });
});
