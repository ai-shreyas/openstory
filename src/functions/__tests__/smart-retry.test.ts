/**
 * Tests for `executeSmartRetry` (#839).
 *
 * Pins the orchestration the June 6 incident exposed:
 *   - the generation mutex gates EVERY retry shape — a sequence marked
 *     'failed' does not imply its workflow tree is dead, so a retry racing a
 *     live pipeline must be rejected before anything is triggered;
 *   - the full-retry fallback goes through `triggerStoryboard` (the mutex /
 *     status-write owner), never a bare trigger;
 *   - the sequence-level 'failed' flag is only cleared when something was
 *     actually retried — flipping to 'completed' after a no-op retry is the
 *     lying-status class this PR exists to kill.
 *
 * Failure *detection* lives in `analyzeFailures` (its own test file); the
 * real implementation is used here, driven by shot/sequence fixtures.
 */

import { describe, expect, test, vi } from 'vitest';
import { TEST_FAL_PRICING as FAL_PRICING } from '@/lib/ai/__tests__/fal-pricing-fixture';
import type { Sequence } from '@/lib/db/schema';
import type { ScopedDb } from '@/lib/db/scoped';
import { frameFixtureFor } from '@/lib/mocks/frame-fixtures';
import type { ShotWithImage } from '@/lib/shots/shot-with-image';
import { estimateImageCost, gateEstimate } from '@/lib/billing/cost-estimation';
import { addMicros, ZERO_MICROS } from '@/lib/billing/money';

const assertNoActiveStoryboardMock = vi.fn();
const triggerStoryboardMock = vi.fn();
vi.doMock('@/lib/workflow/launchers', async () => {
  const real = await vi.importActual('@/lib/workflow/launchers');
  return {
    ...real,
    assertNoActiveStoryboard: assertNoActiveStoryboardMock,
    triggerStoryboard: triggerStoryboardMock,
  };
});

const triggerWorkflowMock = vi.fn();
vi.doMock('@/lib/workflow/client', () => ({
  triggerWorkflow: triggerWorkflowMock,
}));

const requireCreditsMock = vi.fn();
vi.doMock('@/lib/billing/preflight', () => ({
  requireCredits: requireCreditsMock,
}));

// The live pricing loader reads D1 (unavailable under node tests).
vi.doMock('@/lib/ai/fal-pricing-live', () => ({
  getEffectiveFalPricing: async () => FAL_PRICING,
}));

// Dynamic imports so the mocks above apply (vi.doMock is not hoisted).
const { executeSmartRetry } = await import('../smart-retry');
const { GenerationInProgressError } = await import('@/lib/workflow/launchers');

const NOW = new Date('2026-06-07T00:00:00.000Z');

function makeSequence(overrides: Partial<Sequence> = {}): Sequence {
  return {
    id: 'seq_1',
    teamId: 't1',
    title: 'A sequence',
    script: 'INT. LAB — NIGHT',
    status: 'failed',
    statusError: 'Generation was interrupted',
    workflowRunId: null,
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: 'u1',
    updatedBy: 'u1',
    styleId: 'style_1',
    aspectRatio: '16:9',
    analysisModel: 'anthropic/claude-haiku-4.5',
    analysisDurationMs: 0,
    imageModel: 'nano_banana_2',
    videoModel: 'kling_2_5',
    workflow: null,
    musicUrl: null,
    musicPath: null,
    // Music completed by default so tests exercise the image paths without
    // tripping the music / music-prompt retry branches.
    musicStatus: 'completed',
    musicGeneratedAt: null,
    musicError: null,
    musicModel: null,
    musicPrompt: 'ambient synths',
    musicTags: null,
    musicPromptInputHash: null,
    includeMusic: true,
    posterUrl: null,
    autoGenerateMotion: false,
    autoGenerateMusic: false,
    suggestedTalentIds: null,
    suggestedLocationIds: null,
    ...overrides,
  };
}

// The still-image surface moved off `shots` onto the anchor `frame` in #989;
// `executeSmartRetry` projects `ShotWithImage` from each shot + its frame, so the
// fixture keeps the legacy projected names (`thumbnail*`/`image*`) AND mirrors
// them onto a concrete anchor `frame` (id == shot.id) so the projection the
// source builds reflects the per-test overrides.
function makeShot(overrides: Partial<ShotWithImage> = {}): ShotWithImage {
  const base: Omit<ShotWithImage, 'frame'> = {
    id: 'shot-1',
    sequenceId: 'seq_1',
    sceneId: null,
    shotNumber: null,
    orderIndex: 0,
    description: 'A scene',
    durationMs: 3000,
    thumbnailUrl: 'https://cdn/thumb.jpg',
    thumbnailPath: null,
    thumbnailStatus: 'completed',
    thumbnailWorkflowRunId: null,
    thumbnailError: null,
    imageModel: null,
    imagePrompt: null,
    variantImageUrl: null,
    variantImageStatus: 'pending',
    videoUrl: null,
    videoPath: null,
    videoStatus: 'pending',
    videoWorkflowRunId: null,
    videoGeneratedAt: null,
    videoError: null,
    motionPrompt: 'slow pan',
    motionModel: null,
    motionPromptData: null,
    selectedMotionPromptVersionId: null,
    renderSegmentId: null,
    audioUrl: null,
    audioPath: null,
    audioStatus: 'pending',
    audioWorkflowRunId: null,
    audioGeneratedAt: null,
    audioError: null,
    audioModel: null,
    thumbnailInputHash: null,
    videoInputHash: null,
    audioInputHash: null,
    visualPromptInputHash: null,
    motionPromptInputHash: null,
    previewThumbnailUrl: null,
    metadata: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
  return { ...base, frame: anchorFixture(base).frame };
}

/**
 * The two rows the projection consumes. The frame keeps its own id — distinct
 * from the shot id (#989); only shotId links them.
 */
const anchorFixture = (shot: Omit<ShotWithImage, 'frame'>) =>
  frameFixtureFor(shot, `frame-${shot.id}`);

/**
 * The model each shot's selected image / video version was rendered with
 * (#1066) — `shotId → model`, exactly what the scoped bulk reads return.
 */
type SelectedModels = {
  image?: Map<string, string>;
  video?: Map<string, string>;
  /** `shotId → model` of each shot's newest FAILED version (#1066). */
  failedImage?: Map<string, string>;
  failedVideo?: Map<string, string>;
};

function makeContext(
  sequence: Sequence,
  shots: ShotWithImage[],
  selectedModels: SelectedModels = {}
) {
  const updateStatus = vi.fn();
  const updateMusicFields = vi.fn();
  const listBySequence = vi.fn(async () => shots);
  const ensureAnchorFrames = vi.fn(async () => {});
  // The image surface lives on each shot's anchor frame now (#989); the source
  // projects `ShotWithImage` from `shots` + anchor `frames`, so expose the
  // anchors here (keyed by shotId, never id-reuse).
  const anchors = shots.map((s) => anchorFixture(s));
  const listAnchorsBySequence = vi.fn(async () => anchors.map((a) => a.frame));
  // The still itself is the selected `frame_variants` row (#1067).
  const getSelectedByFrameIds = vi.fn(
    async () =>
      new Map(
        anchors.flatMap((a) =>
          a.selectedVersion ? [[a.frame.id, a.selectedVersion]] : []
        )
      )
  );
  const listWithSheets = vi.fn(async () => []);
  // Model identity lives on the version that produced each asset (#1066); an
  // empty map means nothing has been rendered yet → shots inherit the sequence
  // default, preserving the legacy single-model path.
  const listSelectedImageModels = vi.fn(
    async () => selectedModels.image ?? new Map<string, string>()
  );
  const listSelectedVideoModels = vi.fn(
    async () => selectedModels.video ?? new Map<string, string>()
  );
  // The failed-attempt tier (#1066): every shot smart retry touches is in a
  // failed state, so the model that failed outranks the older selected one.
  const listFailedImageModels = vi.fn(
    async () => selectedModels.failedImage ?? new Map<string, string>()
  );
  const listFailedVideoModels = vi.fn(
    async () => selectedModels.failedVideo ?? new Map<string, string>()
  );
  // Motion prompt is resolved from the selected version now (#713); the retry
  // path reads it per shot. No selected version in these fixtures → resolution
  // falls back to the shot description.
  const getSelectedMotion = vi.fn(async () => null);
  const stub = {
    shots: { listBySequence, ensureAnchorFrames },
    frames: { listAnchorsBySequence },
    frameVariants: {
      listSelectedModelsBySequence: listSelectedImageModels,
      listLastFailedModelsBySequence: listFailedImageModels,
      getSelectedByFrameIds,
    },
    videoVariants: {
      listSelectedModelsBySequence: listSelectedVideoModels,
      listLastFailedModelsBySequence: listFailedVideoModels,
    },
    characters: { listWithSheets },
    shotPromptVersions: { getSelectedMotion },
    sequence: vi.fn(() => ({ updateStatus, updateMusicFields })),
  };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal ScopedDb stub exposing only what executeSmartRetry touches
  const scopedDb = stub as unknown as ScopedDb;
  return {
    context: { sequence, user: { id: 'u1' }, teamId: 't1', scopedDb },
    scopedDb,
    updateStatus,
    listBySequence,
  };
}

function resetMocks() {
  assertNoActiveStoryboardMock.mockReset();
  assertNoActiveStoryboardMock.mockResolvedValue(undefined);
  triggerStoryboardMock.mockReset();
  triggerStoryboardMock.mockResolvedValue({ workflowRunId: 'wf_new' });
  triggerWorkflowMock.mockReset();
  triggerWorkflowMock.mockResolvedValue('wf_child');
  requireCreditsMock.mockReset();
  requireCreditsMock.mockResolvedValue(undefined);
}

describe('executeSmartRetry — generation mutex (#839)', () => {
  test('live storyboard run → rejects before reading shots or triggering anything', async () => {
    resetMocks();
    assertNoActiveStoryboardMock.mockRejectedValue(
      new GenerationInProgressError()
    );
    const { context, listBySequence, updateStatus } = makeContext(
      makeSequence(),
      []
    );

    await expect(executeSmartRetry(context)).rejects.toBeInstanceOf(
      GenerationInProgressError
    );
    expect(listBySequence).not.toHaveBeenCalled();
    expect(triggerStoryboardMock).not.toHaveBeenCalled();
    expect(triggerWorkflowMock).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalled();
  });
});

describe('executeSmartRetry — full retry fallback', () => {
  test('delegates to triggerStoryboard, which owns the mutex and status writes', async () => {
    resetMocks();
    // No shots + failed sequence → analyzeFailures says full retry.
    const { context, scopedDb, updateStatus } = makeContext(makeSequence(), []);

    const result = await executeSmartRetry(context);

    expect(triggerStoryboardMock).toHaveBeenCalledTimes(1);
    expect(triggerStoryboardMock).toHaveBeenCalledWith(
      scopedDb,
      expect.objectContaining({ sequenceId: 'seq_1', teamId: 't1' })
    );
    expect(triggerWorkflowMock).not.toHaveBeenCalled();
    // The launcher owns the 'processing' write — no direct status write here.
    expect(updateStatus).not.toHaveBeenCalled();
    expect(result).toEqual({
      retryType: 'full',
      retriedItems: ['full storyboard'],
    });
  });
});

describe('executeSmartRetry — partial retry status reset', () => {
  test('nothing retriable → throws instead of silently marking the sequence completed', async () => {
    resetMocks();
    // A failed image with no prompt anywhere (imagePrompt, metadata,
    // description all empty) is detected as a failure but can't be retried.
    const shot = makeShot({
      thumbnailStatus: 'failed',
      imagePrompt: null,
      metadata: null,
      description: '',
    });
    const { context, updateStatus } = makeContext(makeSequence(), [shot]);

    await expect(executeSmartRetry(context)).rejects.toThrow(
      /regenerate the sequence/
    );
    expect(triggerWorkflowMock).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalled();
  });

  test('retried images → triggers /image per shot and clears the failed flag', async () => {
    resetMocks();
    const shot = makeShot({
      thumbnailStatus: 'failed',
      imagePrompt: 'A cinematic shot of the lab',
    });
    const { context, updateStatus } = makeContext(makeSequence(), [shot]);

    const result = await executeSmartRetry(context);

    expect(triggerWorkflowMock).toHaveBeenCalledTimes(1);
    expect(triggerWorkflowMock).toHaveBeenCalledWith(
      '/image',
      expect.objectContaining({
        shotId: 'shot-1',
        prompt: 'A cinematic shot of the lab',
        sequenceId: 'seq_1',
      }),
      expect.objectContaining({ label: expect.any(String) })
    );
    expect(updateStatus).toHaveBeenCalledWith('completed');
    expect(result).toEqual({
      retryType: 'smart',
      retriedItems: ['1 image(s)'],
    });
  });

  test('mixed shots: skipped prompt-less shot is not counted as retried', async () => {
    resetMocks();
    // The counting regression #839's review flagged: reporting
    // failedImageShots.length would claim "2 image(s)" here even though
    // only one shot is actually retriable.
    const retriable = makeShot({
      id: 'shot-1',
      thumbnailStatus: 'failed',
      imagePrompt: 'A cinematic shot of the lab',
    });
    const skipped = makeShot({
      id: 'shot-2',
      orderIndex: 1,
      thumbnailStatus: 'failed',
      imagePrompt: null,
      metadata: null,
      description: '',
    });
    const { context, updateStatus } = makeContext(makeSequence(), [
      retriable,
      skipped,
    ]);

    const result = await executeSmartRetry(context);

    expect(triggerWorkflowMock).toHaveBeenCalledTimes(1);
    expect(triggerWorkflowMock).toHaveBeenCalledWith(
      '/image',
      expect.objectContaining({ shotId: 'shot-1' }),
      expect.objectContaining({ label: expect.any(String) })
    );
    expect(result).toEqual({
      retryType: 'smart',
      retriedItems: ['1 image(s)'],
    });
    expect(updateStatus).toHaveBeenCalledWith('completed');
  });

  test('failed motion → triggers /motion with image url, prompt and duration', async () => {
    resetMocks();
    const shot = makeShot({
      videoStatus: 'failed',
      thumbnailStatus: 'completed',
      thumbnailUrl: 'https://cdn/thumb.jpg',
      motionPrompt: 'slow pan across the lab',
      durationMs: 5000,
    });
    const { context, updateStatus } = makeContext(makeSequence(), [shot]);

    const result = await executeSmartRetry(context);

    expect(triggerWorkflowMock).toHaveBeenCalledTimes(1);
    expect(triggerWorkflowMock).toHaveBeenCalledWith(
      '/motion',
      expect.objectContaining({
        shotId: 'shot-1',
        sequenceId: 'seq_1',
        imageUrl: 'https://cdn/thumb.jpg',
        prompt: 'slow pan across the lab',
        duration: 5,
      }),
      expect.objectContaining({ label: expect.any(String) })
    );
    expect(result).toEqual({
      retryType: 'smart',
      retriedItems: ['1 motion video(s)'],
    });
    expect(updateStatus).toHaveBeenCalledWith('completed');
  });

  test('sequence not marked failed → no status write after retrying', async () => {
    resetMocks();
    const shot = makeShot({
      thumbnailStatus: 'failed',
      imagePrompt: 'A cinematic shot of the lab',
    });
    const { context, updateStatus } = makeContext(
      makeSequence({ status: 'completed', statusError: null }),
      [shot]
    );

    await executeSmartRetry(context);

    expect(updateStatus).not.toHaveBeenCalled();
  });

  test('no failures at all → throws', async () => {
    resetMocks();
    const { context } = makeContext(
      makeSequence({ status: 'completed', statusError: null }),
      [makeShot()]
    );

    await expect(executeSmartRetry(context)).rejects.toThrow(
      'No failures found to retry'
    );
  });
});

describe('executeSmartRetry — per-asset model selection (#1066)', () => {
  test("retries each failed image with its selected version's model, summing cost per model", async () => {
    resetMocks();
    // Two failed image shots whose selected image versions were rendered by
    // different models — both differing from the sequence default
    // ('nano_banana_2').
    const shotA = makeShot({
      id: 'shot-a',
      sceneId: 'scene-a',
      thumbnailStatus: 'failed',
      imagePrompt: 'Look A',
    });
    const shotB = makeShot({
      id: 'shot-b',
      orderIndex: 1,
      sceneId: 'scene-b',
      thumbnailStatus: 'failed',
      imagePrompt: 'Look B',
    });
    const { context } = makeContext(makeSequence(), [shotA, shotB], {
      image: new Map([
        ['shot-a', 'gpt_image_2'],
        ['shot-b', 'flux_2_max'],
      ]),
    });

    await executeSmartRetry(context);

    // Each shot retries with the model that produced its current still, not
    // the sequence default.
    expect(triggerWorkflowMock).toHaveBeenCalledWith(
      '/image',
      expect.objectContaining({ shotId: 'shot-a', model: 'gpt_image_2' }),
      expect.objectContaining({ label: expect.any(String) })
    );
    expect(triggerWorkflowMock).toHaveBeenCalledWith(
      '/image',
      expect.objectContaining({ shotId: 'shot-b', model: 'flux_2_max' }),
      expect.objectContaining({ label: expect.any(String) })
    );

    // Pre-flight credit check sums per-shot costs across the two models —
    // a regression to single-model `multiply(cost, count)` pricing would diverge
    // whenever the shots were rendered by differently-priced models.
    const expectedCost = addMicros(
      addMicros(
        ZERO_MICROS,
        gateEstimate(
          estimateImageCost('gpt_image_2', '16:9', 1, { pricing: FAL_PRICING }),
          {
            model: 'gpt_image_2',
            operation: 'smart-retry:image',
          }
        )
      ),
      gateEstimate(
        estimateImageCost('flux_2_max', '16:9', 1, { pricing: FAL_PRICING }),
        {
          model: 'flux_2_max',
          operation: 'smart-retry:image',
        }
      )
    );
    expect(requireCreditsMock).toHaveBeenCalledTimes(1);
    expect(requireCreditsMock.mock.calls[0]?.[1]).toEqual(expectedCost);
  });

  test("retries each failed motion video with its selected version's model", async () => {
    resetMocks();
    const shotA = makeShot({
      id: 'shot-a',
      sceneId: 'scene-a',
      videoStatus: 'failed',
      thumbnailStatus: 'completed',
      thumbnailUrl: 'https://cdn/a.jpg',
    });
    const shotB = makeShot({
      id: 'shot-b',
      orderIndex: 1,
      sceneId: 'scene-b',
      videoStatus: 'failed',
      thumbnailStatus: 'completed',
      thumbnailUrl: 'https://cdn/b.jpg',
    });
    const { context } = makeContext(makeSequence(), [shotA, shotB], {
      video: new Map([
        ['shot-a', 'seedance_v2'],
        ['shot-b', 'kling_v3_pro'],
      ]),
    });

    await executeSmartRetry(context);

    expect(triggerWorkflowMock).toHaveBeenCalledWith(
      '/motion',
      expect.objectContaining({ shotId: 'shot-a', model: 'seedance_v2' }),
      expect.objectContaining({ label: expect.any(String) })
    );
    expect(triggerWorkflowMock).toHaveBeenCalledWith(
      '/motion',
      expect.objectContaining({ shotId: 'shot-b', model: 'kling_v3_pro' }),
      expect.objectContaining({ label: expect.any(String) })
    );
  });

  test('retries the model that FAILED, not the older successful one', async () => {
    resetMocks();
    // shot-a's still came from gpt_image_2. The user then tried flux_2_max and
    // it failed — that failed version is not selectable, so without the
    // failed-attempt tier the retry would silently re-run gpt_image_2: the
    // model the user had already moved on from.
    const shotA = makeShot({
      id: 'shot-a',
      sceneId: 'scene-a',
      thumbnailStatus: 'failed',
      imagePrompt: 'Look A',
    });
    const { context } = makeContext(makeSequence(), [shotA], {
      image: new Map([['shot-a', 'gpt_image_2']]),
      failedImage: new Map([['shot-a', 'flux_2_max']]),
    });

    await executeSmartRetry(context);

    expect(triggerWorkflowMock).toHaveBeenCalledWith(
      '/image',
      expect.objectContaining({ shotId: 'shot-a', model: 'flux_2_max' }),
      expect.objectContaining({ label: expect.any(String) })
    );
    // …and it is priced as flux_2_max, so the estimate matches the charge.
    expect(requireCreditsMock.mock.calls[0]?.[1]).toEqual(
      addMicros(
        ZERO_MICROS,
        gateEstimate(
          estimateImageCost('flux_2_max', '16:9', 1, { pricing: FAL_PRICING }),
          {
            model: 'flux_2_max',
            operation: 'smart-retry:image',
          }
        )
      )
    );
  });

  test('retries the failed video model over the older selected one', async () => {
    resetMocks();
    const shotA = makeShot({
      id: 'shot-a',
      sceneId: 'scene-a',
      videoStatus: 'failed',
      thumbnailStatus: 'completed',
      thumbnailUrl: 'https://cdn/a.jpg',
    });
    const { context } = makeContext(makeSequence(), [shotA], {
      video: new Map([['shot-a', 'seedance_v2']]),
      failedVideo: new Map([['shot-a', 'veo3_1']]),
    });

    await executeSmartRetry(context);

    expect(triggerWorkflowMock).toHaveBeenCalledWith(
      '/motion',
      expect.objectContaining({ shotId: 'shot-a', model: 'veo3_1' }),
      expect.objectContaining({ label: expect.any(String) })
    );
  });

  test('falls back to the sequence default when nothing was ever rendered', async () => {
    resetMocks();
    const shotA = makeShot({
      id: 'shot-a',
      sceneId: 'scene-a',
      thumbnailStatus: 'failed',
      imagePrompt: 'Look A',
    });
    const { context } = makeContext(makeSequence(), [shotA]);

    await executeSmartRetry(context);

    expect(triggerWorkflowMock).toHaveBeenCalledWith(
      '/image',
      expect.objectContaining({ shotId: 'shot-a', model: 'nano_banana_2' }),
      expect.objectContaining({ label: expect.any(String) })
    );
  });
});
