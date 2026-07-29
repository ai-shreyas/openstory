import { describe, expect, it } from 'vitest';
import {
  estimateBatchMotionCost,
  resolveBatchShotVideoModel,
} from './batch-motion-cost';
import { estimateVideoCost, gateEstimate } from '@/lib/billing/cost-estimation';
import { addMicros, ZERO_MICROS } from '@/lib/billing/money';
import { snapDuration } from '@/lib/motion/motion-generation';

const sequence = { videoModel: 'minimax_hailuo_02' };
// `video_variants.model` of each shot's selected version (#1066).
const shotModels = {
  selected: new Map([
    ['shot-a', 'seedance_v2'],
    ['shot-b', 'kling_v3_pro'],
  ]),
  lastFailed: new Map<string, string>(),
};

describe('resolveBatchShotVideoModel', () => {
  it('prefers the explicit batch model over the selected version and sequence', () => {
    expect(
      resolveBatchShotVideoModel(
        { id: 'shot-a' },
        shotModels,
        sequence,
        'kling_v3_pro'
      )
    ).toBe('kling_v3_pro');
  });

  it("resolves the shot's selected video version model when no explicit model", () => {
    expect(
      resolveBatchShotVideoModel({ id: 'shot-a' }, shotModels, sequence)
    ).toBe('seedance_v2');
  });

  it('falls back to the sequence default when the shot has no selected version', () => {
    expect(
      resolveBatchShotVideoModel(
        { id: 'shot-never-rendered' },
        shotModels,
        sequence
      )
    ).toBe('minimax_hailuo_02');
  });

  it("prefers a failed attempt's model over the older selected version", () => {
    // shot-a's last render failed on veo3_1; re-running the batch must retry
    // that model, not silently fall back to the selected seedance_v2.
    const withFailure = {
      selected: shotModels.selected,
      lastFailed: new Map([['shot-a', 'veo3_1']]),
    };
    expect(
      resolveBatchShotVideoModel({ id: 'shot-a' }, withFailure, sequence)
    ).toBe('veo3_1');
    // Shots without a failure are untouched.
    expect(
      resolveBatchShotVideoModel({ id: 'shot-b' }, withFailure, sequence)
    ).toBe('kling_v3_pro');
  });

  it('still lets an explicit batch model override a failed attempt', () => {
    const withFailure = {
      selected: shotModels.selected,
      lastFailed: new Map([['shot-a', 'veo3_1']]),
    };
    expect(
      resolveBatchShotVideoModel(
        { id: 'shot-a' },
        withFailure,
        sequence,
        'kling_v3_pro'
      )
    ).toBe('kling_v3_pro');
  });
});

describe('estimateBatchMotionCost', () => {
  it('sums per-shot cost across shots rendered by different (priced) models', () => {
    const shots = [{ id: 'shot-a' }, { id: 'shot-b' }];
    const expected = addMicros(
      addMicros(
        ZERO_MICROS,
        gateEstimate(
          estimateVideoCost(
            'seedance_v2',
            snapDuration(undefined, 'seedance_v2')
          )
        )
      ),
      gateEstimate(
        estimateVideoCost(
          'kling_v3_pro',
          snapDuration(undefined, 'kling_v3_pro')
        )
      )
    );
    expect(estimateBatchMotionCost(shots, shotModels, sequence)).toEqual(
      expected
    );
  });

  it('prices every shot with the explicit batch model when given', () => {
    const shots = [{ id: 'shot-a' }, { id: 'shot-b' }];
    const perShot = gateEstimate(
      estimateVideoCost('kling_v3_pro', snapDuration(5, 'kling_v3_pro'))
    );
    const expected = addMicros(addMicros(ZERO_MICROS, perShot), perShot);
    expect(
      estimateBatchMotionCost(shots, shotModels, sequence, {
        explicitModel: 'kling_v3_pro',
        duration: 5,
      })
    ).toEqual(expected);
  });

  it('is ZERO for an empty shot list', () => {
    expect(estimateBatchMotionCost([], shotModels, sequence)).toEqual(
      ZERO_MICROS
    );
  });
});
