import { describe, expect, it } from 'vitest';
import {
  estimateBatchMotionCost,
  resolveBatchShotVideoModel,
} from './batch-motion-cost';
import { estimateVideoCost } from '@/lib/billing/cost-estimation';
import { addMicros, ZERO_MICROS } from '@/lib/billing/money';
import { snapDuration } from '@/lib/motion/motion-generation';

const sequence = { videoModel: 'minimax_hailuo_02' };
// `video_variants.model` of each shot's selected version (#1066).
const selectedModelByShot = new Map([
  ['shot-a', 'seedance_v2'],
  ['shot-b', 'kling_v3_pro'],
]);

describe('resolveBatchShotVideoModel', () => {
  it('prefers the explicit batch model over the selected version and sequence', () => {
    expect(
      resolveBatchShotVideoModel(
        { id: 'shot-a' },
        selectedModelByShot,
        sequence,
        'kling_v3_pro'
      )
    ).toBe('kling_v3_pro');
  });

  it("resolves the shot's selected video version model when no explicit model", () => {
    expect(
      resolveBatchShotVideoModel(
        { id: 'shot-a' },
        selectedModelByShot,
        sequence
      )
    ).toBe('seedance_v2');
  });

  it('falls back to the sequence default when the shot has no selected version', () => {
    expect(
      resolveBatchShotVideoModel(
        { id: 'shot-never-rendered' },
        selectedModelByShot,
        sequence
      )
    ).toBe('minimax_hailuo_02');
  });
});

describe('estimateBatchMotionCost', () => {
  it('sums per-shot cost across shots rendered by different (priced) models', () => {
    const shots = [{ id: 'shot-a' }, { id: 'shot-b' }];
    const expected = addMicros(
      addMicros(
        ZERO_MICROS,
        estimateVideoCost('seedance_v2', snapDuration(undefined, 'seedance_v2'))
      ),
      estimateVideoCost('kling_v3_pro', snapDuration(undefined, 'kling_v3_pro'))
    );
    expect(
      estimateBatchMotionCost(shots, selectedModelByShot, sequence)
    ).toEqual(expected);
  });

  it('prices every shot with the explicit batch model when given', () => {
    const shots = [{ id: 'shot-a' }, { id: 'shot-b' }];
    const perShot = estimateVideoCost(
      'kling_v3_pro',
      snapDuration(5, 'kling_v3_pro')
    );
    const expected = addMicros(addMicros(ZERO_MICROS, perShot), perShot);
    expect(
      estimateBatchMotionCost(shots, selectedModelByShot, sequence, {
        explicitModel: 'kling_v3_pro',
        duration: 5,
      })
    ).toEqual(expected);
  });

  it('is ZERO for an empty shot list', () => {
    expect(estimateBatchMotionCost([], selectedModelByShot, sequence)).toEqual(
      ZERO_MICROS
    );
  });
});
