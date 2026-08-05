import { describe, expect, test } from 'vitest';
import { analyzeFailures } from './failure-analysis';
import type { Frame, SceneRow } from '@/lib/db/schema';
import type { Sequence } from '@/lib/db/schema/sequences';
import type { ShotWithImage } from '@/lib/shots/shot-with-image';

// The still-image surface moved off `shots` onto the anchor `frame` in #989;
// the API/client shape `ShotWithImage` preserves the legacy `thumbnail*` /
// `image*` field names that `analyzeFailures` reads, so the fixture keeps them
// (plus the raw anchor `frame`).
function makeShot(overrides: Partial<ShotWithImage> = {}): ShotWithImage {
  const frame: Frame = {
    id: 'shot-1',
    shotId: 'shot-1',
    sequenceId: 'seq-1',
    orderIndex: 0,
    role: 'first',
    previewImageUrl: null,
    imageStatus: 'completed',
    imageWorkflowRunId: null,
    imageError: null,
    selectedImageVersionId: null,
    selectedImagePromptVersionId: null,
    pendingPromoteVersionId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return {
    id: 'shot-1',
    sequenceId: 'seq-1',
    sceneId: null,
    shotNumber: null,
    orderIndex: 0,
    durationMs: 3000,
    thumbnailUrl: 'https://example.com/thumb.jpg',
    thumbnailPath: null,
    thumbnailStatus: 'completed',
    thumbnailWorkflowRunId: null,
    thumbnailError: null,
    imageModel: null,
    imagePrompt: null,
    variantImageUrl: null,
    variantImageStatus: 'pending',
    videoUrl: 'https://example.com/video.mp4',
    videoPath: null,
    videoStatus: 'completed',
    videoWorkflowRunId: null,
    videoGeneratedAt: null,
    videoError: null,
    motionModel: null,
    motionPromptData: {
      fullPrompt: 'Camera pan left',
      dialogue: null,
      audio: null,
    },
    videoInputHash: null,
    thumbnailInputHash: null,
    visualPromptInputHash: null,
    selectedMotionPromptVersionId: null,
    renderSegmentId: null,
    previewThumbnailUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    frame,
    ...overrides,
  };
}

function makeSequence(overrides: Partial<Sequence> = {}): Sequence {
  return {
    id: 'seq-1',
    teamId: 'team-1',
    title: 'Test Sequence',
    script: 'A test script',
    status: 'completed',
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: null,
    updatedBy: null,
    styleId: 'style-1',
    aspectRatio: '16:9',
    analysisModel: 'anthropic/claude-haiku-4.5',
    analysisDurationMs: 0,
    imageModel: 'nano_banana_2',
    videoModel: 'wan_i2v',
    workflow: null,
    musicUrl: null,
    musicPath: null,
    musicStatus: 'pending',
    musicGeneratedAt: null,
    musicError: null,
    musicModel: null,
    musicPrompt: 'Epic cinematic music',
    musicTags: 'epic,cinematic',
    musicPromptInputHash: null,
    includeMusic: true,
    statusError: null,
    workflowRunId: null,
    posterUrl: null,
    autoGenerateMotion: false,
    autoGenerateMusic: false,
    suggestedTalentIds: null,
    suggestedLocationIds: null,
    ...overrides,
  };
}

// Shot labels come from the `scenes` row a shot points at (#1067); shots in the
// fixtures above have no `sceneId`, so they fall back to "Scene <n>".
const SCENES = new Map<string, Pick<SceneRow, 'title'>>([
  ['scene-1', { title: 'The Reveal' }],
  ['scene-2', { title: null }],
]);

describe('analyzeFailures', () => {
  test('labels a failed shot with its scene title, else its order index', () => {
    const shots = [
      makeShot({
        sceneId: 'scene-1',
        thumbnailStatus: 'failed',
        thumbnailUrl: null,
      }),
      makeShot({
        id: 'shot-2',
        orderIndex: 1,
        sceneId: 'scene-2',
        thumbnailStatus: 'failed',
        thumbnailUrl: null,
      }),
      makeShot({
        id: 'shot-3',
        orderIndex: 2,
        thumbnailStatus: 'failed',
        thumbnailUrl: null,
      }),
    ];

    const result = analyzeFailures(shots, makeSequence(), SCENES);

    const imageGroup = result.groups.find((g) => g.category === 'image');
    expect(imageGroup?.shots.map((s) => s.sceneTitle)).toEqual([
      'The Reveal',
      'Scene 2',
      'Scene 3',
    ]);
  });

  test('no failures returns empty summary', () => {
    const shots = [makeShot(), makeShot({ id: 'shot-2', orderIndex: 1 })];
    const sequence = makeSequence();

    const result = analyzeFailures(shots, sequence, SCENES);

    expect(result.hasFailed).toBe(false);
    expect(result.requiresFullRetry).toBe(false);
    expect(result.groups).toHaveLength(0);
    expect(result.totalFailures).toBe(0);
  });

  test('script analysis failure (no shots) requires full retry', () => {
    const sequence = makeSequence({ status: 'failed' });

    const result = analyzeFailures([], sequence, SCENES);

    expect(result.hasFailed).toBe(true);
    expect(result.requiresFullRetry).toBe(true);
    expect(result.headline).toContain('full retry required');
  });

  test('image-only failures', () => {
    const shots = [
      makeShot({
        thumbnailStatus: 'failed',
        thumbnailUrl: null,
        thumbnailError: 'Model timeout',
      }),
      makeShot({ id: 'shot-2', orderIndex: 1 }),
    ];
    const sequence = makeSequence({ status: 'failed' });

    const result = analyzeFailures(shots, sequence, SCENES);

    expect(result.hasFailed).toBe(true);
    expect(result.requiresFullRetry).toBe(false);
    expect(result.groups).toHaveLength(1);
    const [imageGroup] = result.groups;
    if (!imageGroup) throw new Error('test setup: image group missing');
    expect(imageGroup.category).toBe('image');
    expect(imageGroup.shots).toHaveLength(1);
    const [imageShot] = imageGroup.shots;
    if (!imageShot) throw new Error('test setup: image shot missing');
    expect(imageShot.error).toBe('Model timeout');
    expect(result.headline).toContain('1 image failed');
  });

  test('motion-only failures', () => {
    const shots = [
      makeShot({
        videoStatus: 'failed',
        videoUrl: null,
        videoError: 'Generation timeout',
      }),
      makeShot({ id: 'shot-2', orderIndex: 1 }),
    ];
    const sequence = makeSequence({ status: 'failed' });

    const result = analyzeFailures(shots, sequence, SCENES);

    expect(result.hasFailed).toBe(true);
    expect(result.requiresFullRetry).toBe(false);
    const motionGroup = result.groups.find((g) => g.category === 'motion');
    expect(motionGroup).toBeDefined();
    expect(motionGroup?.shots).toHaveLength(1);
    expect(result.headline).toContain('1 motion video failed');
  });

  test('music-only failure', () => {
    const shots = [makeShot()];
    const sequence = makeSequence({
      status: 'failed',
      musicStatus: 'failed',
      musicError: 'Audio model error',
      musicPrompt: 'Epic music',
    });

    const result = analyzeFailures(shots, sequence, SCENES);

    expect(result.hasFailed).toBe(true);
    const musicGroup = result.groups.find((g) => g.category === 'music');
    expect(musicGroup).toBeDefined();
    expect(musicGroup?.error).toBe('Audio model error');
    expect(result.headline).toContain('music generation failed');
  });

  test('mixed failures (image + motion)', () => {
    const shots = [
      makeShot({
        thumbnailStatus: 'failed',
        thumbnailUrl: null,
        thumbnailError: 'Image error',
      }),
      makeShot({
        id: 'shot-2',
        orderIndex: 1,
        videoStatus: 'failed',
        videoError: 'Motion error',
      }),
    ];
    const sequence = makeSequence({ status: 'failed' });

    const result = analyzeFailures(shots, sequence, SCENES);

    expect(result.hasFailed).toBe(true);
    expect(result.groups.length).toBeGreaterThanOrEqual(2);
    expect(result.headline).toContain('image');
    expect(result.headline).toContain('motion');
  });

  test('motion failed but no thumbnail skips motion retry', () => {
    const shots = [
      makeShot({
        thumbnailUrl: null,
        thumbnailStatus: 'failed',
        videoStatus: 'failed',
        videoUrl: null,
      }),
    ];
    const sequence = makeSequence({ status: 'failed' });

    const result = analyzeFailures(shots, sequence, SCENES);

    const motionGroup = result.groups.find((g) => g.category === 'motion');
    expect(motionGroup).toBeUndefined();
    const imageGroup = result.groups.find((g) => g.category === 'image');
    expect(imageGroup).toBeDefined();
  });

  test('missing motion prompts requires full retry', () => {
    const shots = [
      makeShot({
        thumbnailStatus: 'completed',
        motionPromptData: null,
        videoStatus: 'pending',
      }),
    ];
    const sequence = makeSequence({ status: 'failed' });

    const result = analyzeFailures(shots, sequence, SCENES);

    expect(result.requiresFullRetry).toBe(true);
    const promptGroup = result.groups.find(
      (g) => g.category === 'motion-prompts'
    );
    expect(promptGroup).toBeDefined();
    expect(result.headline).toContain('Motion prompts were not generated');
  });

  test('missing music prompt does not require full retry', () => {
    const shots = [makeShot()];
    const sequence = makeSequence({
      status: 'failed',
      musicPrompt: null,
      musicTags: null,
      musicStatus: 'pending',
    });

    const result = analyzeFailures(shots, sequence, SCENES);

    expect(result.requiresFullRetry).toBe(false);
    const promptGroup = result.groups.find(
      (g) => g.category === 'music-prompt'
    );
    expect(promptGroup).toBeDefined();
    expect(result.headline).toContain('music prompt generation failed');
  });

  test('pipeline statusError with only missing prompts forces full retry (#1072)', () => {
    // Scene-split crashed after streaming shots; motion/music phases never
    // ran. Do not claim "music prompt generation failed" or offer smart-retry.
    const shots = [
      makeShot({ motionPromptData: null, videoStatus: 'pending' }),
    ];
    const sequence = makeSequence({
      status: 'failed',
      musicPrompt: null,
      musicTags: null,
      musicStatus: 'pending',
      statusError:
        'Child workflow scene-split failed: Failed query: delete from "scenes"',
    });

    const result = analyzeFailures(shots, sequence, SCENES);

    expect(result.requiresFullRetry).toBe(true);
    expect(result.groups).toHaveLength(0);
    expect(result.headline).toContain('full retry required');
    expect(result.error).toContain('delete from "scenes"');
  });

  test('completed sequence with no failures', () => {
    const shots = [makeShot()];
    const sequence = makeSequence({ status: 'completed' });

    const result = analyzeFailures(shots, sequence, SCENES);

    expect(result.hasFailed).toBe(false);
    expect(result.requiresFullRetry).toBe(false);
  });
});
