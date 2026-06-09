import { describe, expect, it } from 'vitest';
import type { ReferenceImageDescription } from '@/lib/prompts/reference-image-prompt';
import { buildKlingElementsInput } from './build-kling-elements';

const ref = (url: string, description: string): ReferenceImageDescription => ({
  referenceImageUrl: url,
  description,
  role: 'character',
});

describe('buildKlingElementsInput', () => {
  it('returns the base prompt unchanged when there are no references', () => {
    const result = buildKlingElementsInput('A slow dolly in', []);
    expect(result).toEqual({ prompt: 'A slow dolly in', elements: [] });
  });

  it('maps each reference to a frontal_image_url element in order', () => {
    const result = buildKlingElementsInput('A slow dolly in', [
      ref('https://example.com/a.png', 'Alice'),
      ref('https://example.com/b.png', 'Bob'),
    ]);
    expect(result.elements).toEqual([
      { frontal_image_url: 'https://example.com/a.png' },
      { frontal_image_url: 'https://example.com/b.png' },
    ]);
  });

  it('appends an @ElementN legend numbered to match element order', () => {
    const result = buildKlingElementsInput('A slow dolly in', [
      ref('https://example.com/a.png', 'Alice'),
      ref('https://example.com/b.png', 'Bob'),
    ]);
    expect(result.prompt).toContain('A slow dolly in');
    expect(result.prompt).toContain('@Element1: Alice');
    expect(result.prompt).toContain('@Element2: Bob');
  });

  it('drops references with no URL', () => {
    const result = buildKlingElementsInput('A slow dolly in', [
      ref('', 'No image'),
      ref('https://example.com/b.png', 'Bob'),
    ]);
    expect(result.elements).toEqual([
      { frontal_image_url: 'https://example.com/b.png' },
    ]);
    expect(result.prompt).toContain('@Element1: Bob');
    expect(result.prompt).not.toContain('No image');
  });

  it('caps the elements array at 4 (fal limit)', () => {
    const refs = Array.from({ length: 6 }, (_, i) =>
      ref(`https://example.com/${i}.png`, `Ref ${i}`)
    );
    const result = buildKlingElementsInput('A slow dolly in', refs);
    expect(result.elements).toHaveLength(4);
    expect(result.prompt).toContain('@Element4: Ref 3');
    expect(result.prompt).not.toContain('@Element5');
  });

  it('truncates the base prompt (never the legend) to fit the limit', () => {
    const longBase = 'x'.repeat(5000);
    const refs = [ref('https://example.com/a.png', 'Alice')];
    const result = buildKlingElementsInput(longBase, refs, 2500);
    expect(result.prompt.length).toBeLessThanOrEqual(2500);
    // The legend is load-bearing — it must survive truncation in full.
    expect(result.prompt).toContain('@Element1: Alice');
    expect(result.prompt).toContain('...');
  });
});
