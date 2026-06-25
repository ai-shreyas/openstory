import { describe, expect, it } from 'vitest';
import type { ReferenceImageDescription } from '@/lib/prompts/reference-image-prompt';
import { buildSeedanceReferenceInput } from './build-seedance-references';

const STILL = 'https://example.com/still.png';

const ref = (url: string, description: string): ReferenceImageDescription => ({
  referenceImageUrl: url,
  description,
  role: 'character',
});

describe('buildSeedanceReferenceInput', () => {
  it('puts the rendered still first as @Image1 and refs after', () => {
    const result = buildSeedanceReferenceInput('A slow dolly in', STILL, [
      ref('https://example.com/a.png', 'Alice'),
      ref('https://example.com/b.png', 'Bob'),
    ]);
    expect(result.imageUrls).toEqual([
      STILL,
      'https://example.com/a.png',
      'https://example.com/b.png',
    ]);
    expect(result.prompt).toContain('A slow dolly in');
    expect(result.prompt).toContain('@Image1: the established shot');
    expect(result.prompt).toContain('@Image2: Alice');
    expect(result.prompt).toContain('@Image3: Bob');
  });

  it('passes only the still when there are no references', () => {
    const result = buildSeedanceReferenceInput('A slow dolly in', STILL, []);
    expect(result.imageUrls).toEqual([STILL]);
    expect(result.prompt).toContain('@Image1: the established shot');
    expect(result.prompt).not.toContain('@Image2');
  });

  it('drops references with no URL', () => {
    const result = buildSeedanceReferenceInput('A slow dolly in', STILL, [
      ref('', 'No image'),
      ref('https://example.com/b.png', 'Bob'),
    ]);
    expect(result.imageUrls).toEqual([STILL, 'https://example.com/b.png']);
    expect(result.prompt).toContain('@Image2: Bob');
    expect(result.prompt).not.toContain('No image');
  });

  it('caps total images at 9 (still + 8 refs)', () => {
    const refs = Array.from({ length: 12 }, (_, i) =>
      ref(`https://example.com/${i}.png`, `Ref ${i}`)
    );
    const result = buildSeedanceReferenceInput('A slow dolly in', STILL, refs);
    expect(result.imageUrls).toHaveLength(9);
    expect(result.imageUrls[0]).toBe(STILL);
    expect(result.prompt).toContain('@Image9: Ref 7');
    expect(result.prompt).not.toContain('@Image10');
  });

  it('truncates the base prompt (never the legend) to fit the limit', () => {
    const longBase = 'x'.repeat(5000);
    const result = buildSeedanceReferenceInput(
      longBase,
      STILL,
      [ref('https://example.com/a.png', 'Alice')],
      2500
    );
    expect(result.prompt.length).toBeLessThanOrEqual(2500);
    expect(result.prompt).toContain('@Image2: Alice');
    expect(result.prompt).toContain('...');
  });
});
