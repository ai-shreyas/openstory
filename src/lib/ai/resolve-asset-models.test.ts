import { describe, expect, it } from 'vitest';
import { resolveImageModel, resolveVideoModel } from './resolve-asset-models';

describe('resolveImageModel', () => {
  it('prefers the explicit per-request model', () => {
    expect(
      resolveImageModel({
        explicit: 'gpt_image_2',
        selectedVersionModel: 'nano_banana_pro',
        sequenceModel: 'flux_2_max',
      })
    ).toBe('gpt_image_2');
  });

  it('uses the selected version model when there is no explicit one', () => {
    expect(
      resolveImageModel({
        selectedVersionModel: 'nano_banana_pro',
        sequenceModel: 'flux_2_max',
      })
    ).toBe('nano_banana_pro');
  });

  it('falls back to the sequence default with no selected version', () => {
    expect(
      resolveImageModel({
        selectedVersionModel: null,
        sequenceModel: 'flux_2_max',
      })
    ).toBe('flux_2_max');
    expect(resolveImageModel({})).toBe('gpt_image_2');
  });

  it('falls through to the NEXT tier when a tier is set but retired', () => {
    // A model id retired after the version was written must not skip the
    // user's sequence choice for the global app default.
    expect(
      resolveImageModel({
        selectedVersionModel: 'retired_model',
        sequenceModel: 'flux_2_max',
      })
    ).toBe('flux_2_max');
  });

  it('falls back to the app default when every tier is invalid/empty', () => {
    expect(
      resolveImageModel({
        explicit: 'not_a_model',
        selectedVersionModel: 'also_not_a_model',
        sequenceModel: '',
      })
    ).toBe('gpt_image_2');
  });
});

describe('resolveVideoModel', () => {
  it('prefers the explicit per-request model', () => {
    expect(
      resolveVideoModel({
        explicit: 'seedance_v2',
        selectedVersionModel: 'kling_v3_pro',
        sequenceModel: 'kling_v3_pro',
      })
    ).toBe('seedance_v2');
  });

  it('uses the selected version model when there is no explicit one', () => {
    expect(
      resolveVideoModel({
        selectedVersionModel: 'kling_v3_pro',
        sequenceModel: 'seedance_v2',
      })
    ).toBe('kling_v3_pro');
  });

  it('falls back to the sequence default with no selected version', () => {
    expect(
      resolveVideoModel({
        selectedVersionModel: null,
        sequenceModel: 'kling_v3_pro',
      })
    ).toBe('kling_v3_pro');
    expect(resolveVideoModel({})).toBe('seedance_v2');
  });

  it('falls through to the NEXT tier when a tier is set but retired', () => {
    expect(
      resolveVideoModel({
        selectedVersionModel: 'retired_model',
        sequenceModel: 'kling_v3_pro',
      })
    ).toBe('kling_v3_pro');
  });

  it('falls back to the app default when every tier is invalid/empty', () => {
    expect(
      resolveVideoModel({
        selectedVersionModel: 'bogus',
        sequenceModel: '',
      })
    ).toBe('seedance_v2');
  });
});
