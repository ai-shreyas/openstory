import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import {
  clearVariantUpscalePreview,
  getVariantUpscalePreview,
  setVariantUpscalePreview,
  variantUpscaleKeys,
} from './variant-upscale-preview';

describe('variant upscale preview cache', () => {
  it('round-trips a preview and survives a second set on the same shot', () => {
    const qc = new QueryClient();
    setVariantUpscalePreview(qc, 'shot-1', {
      variantIndex: 4,
      gridUrl: '/r2/thumbnails/grid.png',
      aspectRatio: '16:9',
    });
    expect(getVariantUpscalePreview(qc, 'shot-1')).toEqual({
      variantIndex: 4,
      gridUrl: '/r2/thumbnails/grid.png',
      aspectRatio: '16:9',
    });
    expect(qc.getQueryData(variantUpscaleKeys.shot('shot-2'))).toBeUndefined();

    setVariantUpscalePreview(qc, 'shot-1', {
      variantIndex: 0,
      gridUrl: '/r2/thumbnails/grid.png',
      aspectRatio: '16:9',
    });
    expect(getVariantUpscalePreview(qc, 'shot-1')?.variantIndex).toBe(0);
  });

  it('clearing one shot does not drop another', () => {
    const qc = new QueryClient();
    setVariantUpscalePreview(qc, 'shot-1', {
      variantIndex: 1,
      gridUrl: '/r2/a.png',
      aspectRatio: '16:9',
    });
    setVariantUpscalePreview(qc, 'shot-2', {
      variantIndex: 2,
      gridUrl: '/r2/b.png',
      aspectRatio: '9:16',
    });
    clearVariantUpscalePreview(qc, 'shot-1');
    expect(getVariantUpscalePreview(qc, 'shot-1')).toBeNull();
    expect(getVariantUpscalePreview(qc, 'shot-2')?.variantIndex).toBe(2);
  });
});
