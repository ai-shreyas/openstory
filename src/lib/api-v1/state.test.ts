import { dbSceneId, type SceneRow, type VideoVariant } from '@/lib/db/schema';
import type { Style } from '@/lib/db/schema/libraries';
import type { Sequence } from '@/lib/db/schema/sequences';
import { frameFixtureFor, videoFixtureFor } from '@/lib/mocks/frame-fixtures';
import type { ShotWithImage } from '@/lib/shots/shot-with-image';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// Stub the logger so the "style failed to resolve" anomaly path is observable
// (and doesn't print an error line during the run). Hoisted so the mock is in
// place before ./state captures its logger at import.
const { loggerErrorMock } = vi.hoisted(() => ({ loggerErrorMock: vi.fn() }));
vi.mock('@/lib/observability/logger', () => ({
  getLogger: () => ({
    error: loggerErrorMock,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  buildSequenceState as buildSequenceStateRaw,
  isTerminalSequenceState,
  sequenceStateCursor,
} from './state';

// toShareableUrl reads R2_PUBLIC_STORAGE_DOMAIN via getEnv() — process.env
// under vitest, which bun-as-launcher fills from .env.local. A developer who
// opted into remote R2 (the documented wrangler.jsonc workflow) would flip
// the origin-fallback assertions below to their CDN domain; pin local
// serving so the tests are environment-independent. (stubEnv with undefined
// deletes the var — `delete process.env.X` fails typecheck since the env
// typings mark it non-optional.)
beforeAll(() => {
  vi.stubEnv('R2_PUBLIC_STORAGE_DOMAIN', undefined);
});

const TEST_ORIGIN = 'https://api.example.com';

// All existing assertions use absolute `https://cdn/...` URLs, which
// toShareableUrl passes through unchanged; the origin only matters for the
// origin-relative `/r2/...` rows exercised in the dedicated test below. Wrap so
// each call supplies a fixed origin without threading it through every case.
const build = (
  deps: Parameters<typeof buildSequenceStateRaw>[0],
  sequence: Parameters<typeof buildSequenceStateRaw>[1],
  origin = TEST_ORIGIN
) => buildSequenceStateRaw(deps, sequence, origin);

// The still-image surface moved off `shots` onto the anchor `frame` in #989;
// `buildSequenceState` projects `ShotWithImage` from each shot + its frame, so
// the fixture keeps the legacy projected names (`thumbnail*`/`image*`) AND
// mirrors them onto a concrete anchor `frame` whose id is DISTINCT from the
// shot id (only `shotId` links them — never id-reuse).
function makeShot(overrides: Partial<ShotWithImage> = {}): ShotWithImage {
  const base: Omit<ShotWithImage, 'frame'> = {
    id: 'shot-1',
    sequenceId: 'seq-1',
    sceneId: null,
    shotNumber: null,
    orderIndex: 0,
    durationMs: 3000,
    thumbnailUrl: null,
    thumbnailPath: null,
    thumbnailStatus: 'pending',
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
    motionPrompt: null,
    motionModel: null,
    motionPromptData: null,
    thumbnailInputHash: null,
    videoInputHash: null,
    visualPromptInputHash: null,
    motionPromptInputHash: null,
    selectedMotionPromptVersionId: null,
    renderSegmentId: null,
    previewThumbnailUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  return { ...base, frame: anchorFixture(base).frame };
}

/** The two DB rows `buildSequenceState` projects a shot's image surface from. */
const anchorFixture = (shot: Omit<ShotWithImage, 'frame'>) =>
  frameFixtureFor(shot, `frame-${shot.id}`);

/**
 * The segment's newest primary render — the row the shot's video lifecycle is
 * derived from (#1067). `videoFixtureFor` is url-gated, so a render that never
 * produced one borrows an empty url and puts the real (null) one back.
 */
function primaryVideoFixture(shot: ShotWithImage): VideoVariant | null {
  const status = shot.videoStatus;
  if (status === null) return null;
  const row = videoFixtureFor({ ...shot, videoUrl: shot.videoUrl ?? '' });
  if (!row) return null;
  return {
    ...row,
    url: shot.videoUrl,
    status,
    error: shot.videoError,
    workflowRunId: shot.videoWorkflowRunId,
  };
}

function makeSequence(overrides: Partial<Sequence> = {}): Sequence {
  return {
    id: 'seq-1',
    teamId: 'team-1',
    title: 'Test Sequence',
    script: 'A test script',
    status: 'processing',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
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
    musicPrompt: null,
    musicTags: null,
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

function makeStyle(overrides: Partial<Style> = {}): Style {
  return {
    id: 'style-1',
    teamId: 'team-1',
    name: 'Cinematic Noir',
    description: null,
    config: {
      mood: 'tense',
      artStyle: 'noir',
      lighting: 'low-key',
      colorPalette: ['#000'],
      cameraWork: 'handheld',
      referenceFilms: [],
      colorGrading: 'desaturated',
    },
    category: null,
    tags: [],
    isPublic: false,
    isTemplate: false,
    version: 1,
    previewUrl: null,
    sampleVideos: [],
    recommendedImageModel: null,
    recommendedVideoModel: null,
    defaultAspectRatio: null,
    useCases: [],
    sortOrder: 100,
    usageCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: null,
    ...overrides,
  };
}

function makeScene(overrides: Partial<SceneRow> = {}): SceneRow {
  return {
    id: dbSceneId('scene-1'),
    sequenceId: 'seq-1',
    orderIndex: 0,
    location: null,
    timeOfDay: null,
    storyBeat: null,
    title: null,
    continuity: null,
    musicDesign: null,
    originalScript: null,
    selectedScriptVersionId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function depsWithShots(
  shots: ShotWithImage[],
  style: Style | null = makeStyle(),
  scenes: SceneRow[] = []
) {
  // The image surface lives on each shot's anchor frame now (#989), the still
  // itself on that frame's SELECTED version and the video on the SELECTED
  // version of the shot's render segment (#1067); the source projects
  // `ShotWithImage` from all of them.
  const anchors = shots.map((s) => anchorFixture(s));
  return {
    shots: { listBySequence: async () => shots },
    frames: { listAnchorsBySequence: async () => anchors.map((a) => a.frame) },
    frameVariants: {
      getSelectedByFrameIds: async () =>
        new Map(
          anchors.flatMap((a) =>
            a.selectedVersion ? [[a.frame.id, a.selectedVersion]] : []
          )
        ),
    },
    videoVariants: {
      getSelectedByShotIds: async () =>
        new Map(
          shots.flatMap((s) => {
            const selected = videoFixtureFor(s);
            return selected ? [[s.id, selected]] : [];
          })
        ),
      getPrimaryByShotIds: async () =>
        new Map(
          shots.flatMap((s) => {
            const primary = primaryVideoFixture(s);
            return primary ? [[s.id, primary]] : [];
          })
        ),
    },
    styles: { getById: async () => style },
    scenes: { listBySequence: async () => scenes },
  };
}

describe('buildSequenceState', () => {
  it('maps top-level sequence fields and ISO timestamps', async () => {
    const sequence = makeSequence({
      posterUrl: 'https://cdn/poster.png',
      musicStatus: 'completed',
      musicUrl: 'https://cdn/music.mp3',
      statusError: null,
    });
    const state = await build(depsWithShots([]), sequence);

    expect(state).toMatchObject({
      id: 'seq-1',
      title: 'Test Sequence',
      status: 'processing',
      aspectRatio: '16:9',
      style: { id: 'style-1', name: 'Cinematic Noir' },
      models: {
        analysis: 'anthropic/claude-haiku-4.5',
        image: 'nano_banana_2',
        video: 'wan_i2v',
        music: null,
      },
      poster: { url: 'https://cdn/poster.png' },
      music: { status: 'completed', url: 'https://cdn/music.mp3' },
    });
    expect(state.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(state.counts).toEqual({
      shots: 0,
      imagesReady: 0,
      videosReady: 0,
      videosFailed: 0,
    });
    expect(state.poster).not.toBeNull();
  });

  it('keeps the style id but nulls the name and logs when the style fails to resolve', async () => {
    loggerErrorMock.mockClear();
    const state = await build(
      depsWithShots([], null),
      makeSequence({ styleId: 'style-deleted', musicModel: 'elevenlabs_music' })
    );
    expect(state.style).toEqual({ id: 'style-deleted', name: null });
    expect(state.models.music).toBe('elevenlabs_music');
    // The unresolved style is surfaced, not silently swallowed.
    expect(loggerErrorMock).toHaveBeenCalledWith(expect.any(String), {
      sequenceId: 'seq-1',
      styleId: 'style-deleted',
    });
  });

  it('null poster and falls back to pending music status', async () => {
    const state = await build(
      depsWithShots([]),
      makeSequence({ posterUrl: null, musicStatus: null })
    );
    expect(state.poster).toBeNull();
    expect(state.music.status).toBe('pending');
  });

  it('derives per-shot image/video status and counts, ordered by index', async () => {
    const shots = [
      makeShot({
        id: 'f2',
        orderIndex: 1,
        videoUrl: 'https://cdn/v2.mp4',
        videoStatus: 'completed',
      }),
      makeShot({
        id: 'f1',
        orderIndex: 0,
        thumbnailUrl: 'https://cdn/t1.png',
      }),
    ];
    const state = await build(depsWithShots(shots), makeSequence());

    // ordered by orderIndex
    expect(state.shots.map((f) => f.id)).toEqual(['f1', 'f2']);

    const [first, second] = state.shots;
    expect(first).toMatchObject({
      id: 'f1',
      image: { status: 'completed', url: 'https://cdn/t1.png' },
      video: { status: 'pending', url: null },
    });
    expect(second).toMatchObject({
      id: 'f2',
      image: { status: 'pending', url: null },
      video: { status: 'completed', url: 'https://cdn/v2.mp4' },
    });
    // No scene → title falls back to null.
    expect(first?.title).toBeNull();

    expect(state.counts).toEqual({
      shots: 2,
      imagesReady: 1,
      videosReady: 1,
      videosFailed: 0,
    });
  });

  it('titles a shot from the scene it belongs to', async () => {
    const scene = makeScene({ title: 'The Reveal' });
    const state = await build(
      depsWithShots(
        [
          makeShot({ sceneId: scene.id }),
          makeShot({ id: 'f2', orderIndex: 1 }),
        ],
        makeStyle(),
        [scene]
      ),
      makeSequence()
    );
    expect(state.shots.map((s) => s.title)).toEqual(['The Reveal', null]);
  });

  it('treats a preview thumbnail as an available image', async () => {
    const state = await build(
      depsWithShots([
        makeShot({
          thumbnailUrl: null,
          previewThumbnailUrl: 'https://cdn/p.png',
        }),
      ]),
      makeSequence()
    );
    expect(state.shots[0]?.image).toEqual({
      status: 'completed',
      url: 'https://cdn/p.png',
    });
  });

  it('counts failed videos so a terminal-but-partial result is legible', async () => {
    const state = await build(
      depsWithShots([
        makeShot({ id: 'f1', videoStatus: 'failed' }),
        makeShot({
          id: 'f2',
          orderIndex: 1,
          videoStatus: 'completed',
          videoUrl: 'https://cdn/v.mp4',
        }),
      ]),
      makeSequence()
    );
    expect(state.counts).toEqual({
      shots: 2,
      imagesReady: 0,
      videosReady: 1,
      videosFailed: 1,
    });
  });

  it('absolutizes origin-relative media URLs against the request origin', async () => {
    // No CDN domain in the unit env, so toShareableUrl falls back to the
    // request origin. Stored rows are `/r2/...` (#894); the API must hand
    // off-origin clients a usable absolute URL.
    const state = await build(
      depsWithShots([
        makeShot({
          id: 'f1',
          thumbnailUrl: '/r2/thumbnails/team/t1.png',
          videoStatus: 'completed',
          videoUrl: '/r2/videos/team/v1.mp4',
        }),
      ]),
      makeSequence({
        posterUrl: '/r2/thumbnails/team/poster.png',
        musicStatus: 'completed',
        musicUrl: '/r2/audio/team/music.mp3',
      })
    );

    expect(state.poster).toEqual({
      url: 'https://api.example.com/r2/thumbnails/team/poster.png',
    });
    expect(state.music.url).toBe(
      'https://api.example.com/r2/audio/team/music.mp3'
    );
    expect(state.shots[0]?.image.url).toBe(
      'https://api.example.com/r2/thumbnails/team/t1.png'
    );
    expect(state.shots[0]?.video.url).toBe(
      'https://api.example.com/r2/videos/team/v1.mp4'
    );
  });

  it('passes through already-absolute (external / legacy) media URLs', async () => {
    const state = await build(
      depsWithShots([
        makeShot({
          videoStatus: 'completed',
          videoUrl: 'https://v3.fal.media/files/b/abc/out.mp4',
        }),
      ]),
      makeSequence({ posterUrl: 'https://storage.openstory.so/old/poster.png' })
    );
    expect(state.poster?.url).toBe(
      'https://storage.openstory.so/old/poster.png'
    );
    expect(state.shots[0]?.video.url).toBe(
      'https://v3.fal.media/files/b/abc/out.mp4'
    );
  });
});

describe('isTerminalSequenceState', () => {
  it('treats completed / failed / archived as terminal', async () => {
    for (const status of ['completed', 'failed', 'archived'] as const) {
      const state = await build(depsWithShots([]), makeSequence({ status }));
      expect(isTerminalSequenceState(state)).toBe(true);
    }
  });

  it('treats draft / processing as non-terminal', async () => {
    for (const status of ['draft', 'processing'] as const) {
      const state = await build(depsWithShots([]), makeSequence({ status }));
      expect(isTerminalSequenceState(state)).toBe(false);
    }
  });
});

describe('sequenceStateCursor', () => {
  // The cursor is the entire long-poll contract: it must change the instant any
  // pollable field advances, and stay stable otherwise. In production any row
  // touch also bumps `updatedAt` (itself in the cursor), so we PIN `updatedAt`
  // here to prove each remaining term is load-bearing on its own — otherwise a
  // dropped term would be dead code that `?wait` silently relies on.
  const updatedAt = new Date('2026-01-02T00:00:00Z');

  it('is stable for identical state', async () => {
    const seq = makeSequence({ updatedAt });
    const a = await build(depsWithShots([]), seq);
    const b = await build(depsWithShots([]), seq);
    expect(sequenceStateCursor(a)).toBe(sequenceStateCursor(b));
  });

  it('changes when each polled field advances independently', async () => {
    const baseline = sequenceStateCursor(
      await build(depsWithShots([]), makeSequence({ updatedAt }))
    );

    const cursorFor = async (
      shots: Parameters<typeof depsWithShots>[0],
      seqOverrides: Parameters<typeof makeSequence>[0]
    ) =>
      sequenceStateCursor(
        await build(
          depsWithShots(shots),
          makeSequence({ updatedAt, ...seqOverrides })
        )
      );

    // overall status
    expect(await cursorFor([], { status: 'completed' })).not.toBe(baseline);
    // music status
    expect(await cursorFor([], { musicStatus: 'completed' })).not.toBe(
      baseline
    );
    // poster appears
    expect(await cursorFor([], { posterUrl: 'https://cdn/p.png' })).not.toBe(
      baseline
    );
    // an image becomes ready
    expect(
      await cursorFor([makeShot({ thumbnailUrl: 'https://cdn/t.png' })], {})
    ).not.toBe(baseline);
    // a video becomes ready
    expect(
      await cursorFor(
        [
          makeShot({
            videoStatus: 'completed',
            videoUrl: 'https://cdn/v.mp4',
          }),
        ],
        {}
      )
    ).not.toBe(baseline);
    // a video fails — must wake the poll, not stall it until the deadline
    expect(await cursorFor([makeShot({ videoStatus: 'failed' })], {})).not.toBe(
      baseline
    );
  });
});
