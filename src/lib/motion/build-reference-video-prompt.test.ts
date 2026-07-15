import { describe, expect, it } from 'vitest';
import { getMotionReferenceEndpoint } from '@/lib/ai/models';
import type { MotionReferenceEndpointConfig } from '@/lib/ai/models';
import type { ReferenceImageDescription } from '@/lib/prompts/reference-image-prompt';
import { buildReferenceVideoPrompt } from './build-reference-video-prompt';

const STILL = 'https://example.com/still.png';

const seedanceConfig = getMotionReferenceEndpoint('seedance_v2');
if (!seedanceConfig) {
  throw new Error('seedance_v2 must have a reference endpoint config');
}

const ref = (url: string, description: string): ReferenceImageDescription => ({
  referenceImageUrl: url,
  description,
  role: 'character',
});

describe('buildReferenceVideoPrompt (Seedance config)', () => {
  it('puts the rendered still first as @Image1 and refs after', () => {
    const result = buildReferenceVideoPrompt(
      seedanceConfig,
      'A slow dolly in',
      STILL,
      [
        ref('https://example.com/a.png', 'Alice'),
        ref('https://example.com/b.png', 'Bob'),
      ]
    );
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
    const result = buildReferenceVideoPrompt(
      seedanceConfig,
      'A slow dolly in',
      STILL,
      []
    );
    expect(result.imageUrls).toEqual([STILL]);
    expect(result.prompt).toContain('@Image1: the established shot');
    expect(result.prompt).not.toContain('@Image2');
  });

  it('drops references with no URL', () => {
    const result = buildReferenceVideoPrompt(
      seedanceConfig,
      'A slow dolly in',
      STILL,
      [ref('', 'No image'), ref('https://example.com/b.png', 'Bob')]
    );
    expect(result.imageUrls).toEqual([STILL, 'https://example.com/b.png']);
    expect(result.prompt).toContain('@Image2: Bob');
    expect(result.prompt).not.toContain('No image');
  });

  it('caps total images at maxImages (still + 8 refs for Seedance)', () => {
    const refs = Array.from({ length: 12 }, (_, i) =>
      ref(`https://example.com/${i}.png`, `Ref ${i}`)
    );
    const result = buildReferenceVideoPrompt(
      seedanceConfig,
      'A slow dolly in',
      STILL,
      refs
    );
    expect(result.imageUrls).toHaveLength(9);
    expect(result.imageUrls[0]).toBe(STILL);
    expect(result.prompt).toContain('@Image9: Ref 7');
    expect(result.prompt).not.toContain('@Image10');
  });

  it('truncates the base prompt (never the legend) to fit the limit', () => {
    const longBase = 'x'.repeat(5000);
    const result = buildReferenceVideoPrompt(
      seedanceConfig,
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

describe('buildReferenceVideoPrompt (per-model config knobs)', () => {
  // Gemini Omni Flash-style config: 0-indexed angle-bracket tags, tighter cap.
  const omniStyleConfig: MotionReferenceEndpointConfig = {
    endpointId: 'google/gemini-omni-flash/reference-to-video',
    tag: (position) => `<IMAGE_REF_${position - 1}>`,
    maxImages: 4,
  };

  it('renders the model-specific tag syntax in the legend', () => {
    const result = buildReferenceVideoPrompt(
      omniStyleConfig,
      'A slow dolly in',
      STILL,
      [ref('https://example.com/a.png', 'Alice')]
    );
    expect(result.prompt).toContain('<IMAGE_REF_0>: the established shot');
    expect(result.prompt).toContain('<IMAGE_REF_1>: Alice');
    expect(result.prompt).not.toContain('@Image');
  });

  it('caps total images at the config maxImages', () => {
    const refs = Array.from({ length: 6 }, (_, i) =>
      ref(`https://example.com/${i}.png`, `Ref ${i}`)
    );
    const result = buildReferenceVideoPrompt(
      omniStyleConfig,
      'A slow dolly in',
      STILL,
      refs
    );
    expect(result.imageUrls).toHaveLength(4);
    expect(result.prompt).toContain('<IMAGE_REF_3>: Ref 2');
    expect(result.prompt).not.toContain('<IMAGE_REF_4>');
  });
});
