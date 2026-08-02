/**
 * `computePlan` decides what "Update all" (#1077) regenerates — and therefore
 * what the user is billed for. These cover the gating rules that are cheap to
 * regress and expensive to get wrong: only-currently-stale targeting, the
 * never-create-a-first-still guard, the deliberate no-cascade, scope
 * precedence, and the skip reporting that stops a partial run reading as a
 * clean one.
 */

import type { Frame, Shot } from '@/lib/db/schema';
import type { ScopedDb } from '@/lib/db/scoped';
import type { Scene } from '@/lib/ai/scene-analysis.schema';
import type { ShotStalenessResult } from '@/lib/shots/shot-staleness';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const FRESH: ShotStalenessResult = {
  thumbnail: 'fresh',
  visualPrompt: 'fresh',
  motionPrompt: 'fresh',
  liveHashes: {
    thumbnail: 'live-thumb',
    visualPrompt: 'live-visual',
    motionPrompt: 'live-motion',
  },
};

// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test stub; computePlan only reads sceneId off the scene
const scene = { sceneId: 'scene-1' } as unknown as Scene;

function makeShot(overrides: Partial<Shot> = {}): Shot {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal Shot stub exposing only what computePlan reads
  return {
    id: 'shot-1',
    sceneId: 'scene-1',
    metadata: scene,
    ...overrides,
  } as unknown as Shot;
}

function makeFrame(overrides: Partial<Frame> = {}): Frame {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal Frame stub exposing only what computePlan reads
  return {
    id: 'frame-1',
    shotId: 'shot-1',
    imageUrl: 'https://example.com/a.jpg',
    ...overrides,
  } as unknown as Frame;
}

/** Staleness keyed by shot id; anything unlisted reads fresh. */
const stalenessByShot = new Map<string, ShotStalenessResult>();

vi.doMock('@/lib/shots/shot-staleness', () => ({
  computeShotStaleness: vi.fn(
    ({ shot }: { shot: Shot }) => stalenessByShot.get(shot.id) ?? FRESH
  ),
}));
vi.doMock('@/lib/scenes/scene-script', () => ({
  loadSelectedScriptsBySequence: vi.fn(() => Promise.resolve(new Map())),
  resolveSceneForShot: vi.fn((shot: Shot) => ({
    scene: shot.metadata ?? null,
    script: null,
  })),
}));
vi.doMock('@/lib/ai/prompt-context', () => ({
  loadShotPromptContext: vi.fn(() =>
    Promise.resolve({
      characterBible: [],
      locationBible: [],
      elementBible: [],
      styleConfig: {},
      analysisModel: 'x',
    })
  ),
}));

const { computePlan, claimTargets } =
  await import('./update-stale-shots-workflow');

function buildScopedDb(shots: Shot[], frames: Frame[]): ScopedDb {
  return asScopedDb({
    sequences: {
      getById: () =>
        Promise.resolve({ id: 'seq-1', aspectRatio: '16:9', styleId: 'st-1' }),
    },
    shots: {
      listBySequence: () => Promise.resolve(shots),
      ensureAnchorFrames: () => Promise.resolve(undefined),
    },
    frames: { listAnchorsBySequence: () => Promise.resolve(frames) },
    characters: { listWithSheets: () => Promise.resolve([]) },
    sequenceLocations: { listWithReferences: () => Promise.resolve([]) },
    sequenceElements: { list: () => Promise.resolve([]) },
  });
}

/** Minimal ScopedDb stub exposing only the namespaces computePlan touches. */
function asScopedDb<T>(stub: T): ScopedDb {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test stub
  return stub as unknown as ScopedDb;
}

const plan = (
  shots: Shot[],
  frames: Frame[],
  scope: { sceneId?: string; shotId?: string } = {}
) =>
  computePlan({
    scopedDb: buildScopedDb(shots, frames),
    sequenceId: 'seq-1',
    ...scope,
  });

beforeEach(() => stalenessByShot.clear());

describe('computePlan — what gets regenerated', () => {
  it('targets nothing when every artifact reads fresh', async () => {
    const result = await plan([makeShot()], [makeFrame()]);
    expect(result.targets).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('does not cascade: a stale visual prompt leaves a fresh image alone', async () => {
    stalenessByShot.set('shot-1', { ...FRESH, visualPrompt: 'stale' });
    const result = await plan([makeShot()], [makeFrame()]);
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]).toMatchObject({
      regenVisual: true,
      regenMotion: false,
      regenImage: false,
    });
  });

  it('never renders a first still: a stale thumbnail on a shot with no image is not a target', async () => {
    stalenessByShot.set('shot-1', { ...FRESH, thumbnail: 'stale' });
    const result = await plan([makeShot()], [makeFrame({ imageUrl: null })]);
    expect(result.targets).toEqual([]);
  });

  it('re-renders a stale thumbnail when an image already exists', async () => {
    stalenessByShot.set('shot-1', { ...FRESH, thumbnail: 'stale' });
    const result = await plan([makeShot()], [makeFrame()]);
    expect(result.targets[0]).toMatchObject({
      regenImage: true,
      regenVisual: false,
    });
  });

  it('reports a shot whose staleness could not be computed instead of dropping it', async () => {
    stalenessByShot.set('shot-1', { ...FRESH, visualPrompt: 'unknown' });
    const result = await plan([makeShot()], [makeFrame()]);
    expect(result.targets).toEqual([]);
    expect(result.skipped).toEqual([
      { shotId: 'shot-1', reason: 'staleness-unknown' },
    ]);
  });

  it('reports a shot with no anchor frame rather than silently skipping it', async () => {
    stalenessByShot.set('shot-1', { ...FRESH, visualPrompt: 'stale' });
    const result = await plan([makeShot()], []);
    expect(result.targets).toEqual([]);
    expect(result.skipped).toEqual([
      { shotId: 'shot-1', reason: 'no-anchor-frame' },
    ]);
  });

  it('reports a shot still awaiting script analysis', async () => {
    const result = await plan([makeShot({ metadata: null })], [makeFrame()]);
    expect(result.skipped).toEqual([{ shotId: 'shot-1', reason: 'no-scene' }]);
  });
});

describe("computePlan — 'updating' dedup (#1085)", () => {
  it('does not target an artifact already covered by a live claim', async () => {
    stalenessByShot.set('shot-1', {
      ...FRESH,
      visualPrompt: 'updating',
      motionPrompt: 'stale',
    });
    const result = await plan([makeShot()], [makeFrame()]);
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]).toMatchObject({
      regenVisual: false,
      regenMotion: true,
    });
  });

  it('carries the live hashes the claim rows will be stamped with', async () => {
    stalenessByShot.set('shot-1', { ...FRESH, visualPrompt: 'stale' });
    const result = await plan([makeShot()], [makeFrame()]);
    expect(result.targets[0]).toMatchObject({
      visualLiveHash: 'live-visual',
      motionLiveHash: 'live-motion',
      imageLiveHash: 'live-thumb',
    });
  });
});

describe('claimTargets (#1085)', () => {
  type PendingRow = { id: string; workflowRunId: string | null };

  function makeTarget(
    overrides: Partial<Parameters<typeof claimTargets>[0]['targets'][number]>
  ) {
    return {
      shotId: 'shot-1',
      frameId: 'frame-1',
      beforeShotId: null,
      afterShotId: null,
      startingFrameImageUrl: null,
      regenVisual: false,
      regenMotion: false,
      regenImage: false,
      visualLiveHash: 'vh',
      motionLiveHash: 'mh',
      imageLiveHash: 'ih',
      imageModel: 'nano_banana_2',
      ...overrides,
    };
  }

  function buildClaimDb(opts: {
    existingVisual?: PendingRow | null;
    existingMotion?: PendingRow | null;
    liveImageClaims?: Array<{
      id: string;
      workflowRunId: string | null;
      pendingInputHash: string | null;
      dependsOnVersionId: string | null;
    }>;
  }) {
    const created = {
      visual: [] as unknown[],
      motion: [] as unknown[],
      image: [] as unknown[],
    };
    let seq = 0;
    const db = asScopedDb({
      framePromptVersions: {
        getLivePending: () => Promise.resolve(opts.existingVisual ?? null),
        createPending: (input: unknown) => {
          created.visual.push(input);
          return Promise.resolve({ id: `fpv-${++seq}` });
        },
      },
      shotPromptVersions: {
        getLivePending: () => Promise.resolve(opts.existingMotion ?? null),
        createPending: (input: unknown) => {
          created.motion.push(input);
          return Promise.resolve({ id: `spv-${++seq}` });
        },
      },
      frameVariants: {
        listLiveClaims: () => Promise.resolve(opts.liveImageClaims ?? []),
        createPendingClaim: (input: unknown) => {
          created.image.push(input);
          return Promise.resolve({ id: `fv-${++seq}` });
        },
      },
    });
    return { db, created };
  }

  it('creates one pending row per artifact and chains the image onto the visual claim', async () => {
    const { db, created } = buildClaimDb({});
    const result = await claimTargets({
      scopedDb: db,
      targets: [
        makeTarget({ regenVisual: true, regenMotion: true, regenImage: true }),
      ],
      sequenceId: 'seq-1',
      parentInstanceId: 'run-1',
    });

    expect(created.visual).toHaveLength(1);
    expect(created.motion).toHaveLength(1);
    expect(created.image).toHaveLength(1);
    expect(created.visual[0]).toMatchObject({
      frameId: 'frame-1',
      pendingInputHash: 'vh',
      workflowRunId: 'run-1',
    });
    // Chained image: dependency edge, no direct hash claim.
    expect(created.image[0]).toMatchObject({
      dependsOnVersionId: result.claimsByShot['shot-1']?.visualVersionId,
    });
    expect(created.image[0]).not.toHaveProperty('pendingInputHash', 'ih');
    expect(result.skipped).toEqual([]);
  });

  it('direct image regen (prompt fresh) claims with the image live hash', async () => {
    const { db, created } = buildClaimDb({});
    await claimTargets({
      scopedDb: db,
      targets: [makeTarget({ regenImage: true })],
      sequenceId: 'seq-1',
      parentInstanceId: 'run-1',
    });
    expect(created.image[0]).toMatchObject({
      pendingInputHash: 'ih',
      workflowRunId: 'run-1',
    });
  });

  it('reuses its OWN existing claim on a step retry instead of duplicating', async () => {
    const { db, created } = buildClaimDb({
      existingVisual: { id: 'fpv-prior', workflowRunId: 'run-1' },
    });
    const result = await claimTargets({
      scopedDb: db,
      targets: [makeTarget({ regenVisual: true })],
      sequenceId: 'seq-1',
      parentInstanceId: 'run-1',
    });
    expect(created.visual).toHaveLength(0);
    expect(result.claimsByShot['shot-1']?.visualVersionId).toBe('fpv-prior');
    expect(result.skipped).toEqual([]);
  });

  it("skips an artifact claimed by ANOTHER run and reports 'already-in-flight'", async () => {
    const { db, created } = buildClaimDb({
      existingVisual: { id: 'fpv-foreign', workflowRunId: 'other-run' },
    });
    const result = await claimTargets({
      scopedDb: db,
      targets: [makeTarget({ regenVisual: true, regenImage: true })],
      sequenceId: 'seq-1',
      parentInstanceId: 'run-1',
    });
    expect(created.visual).toHaveLength(0);
    // Chained image must not chain onto a foreign claim.
    expect(created.image).toHaveLength(0);
    expect(result.claimsByShot['shot-1']).toMatchObject({
      visualVersionId: null,
      imageVariantId: null,
    });
    expect(result.skipped).toEqual([
      { shotId: 'shot-1', reason: 'already-in-flight' },
    ]);
  });
});

describe('computePlan — scope', () => {
  const shots = [
    makeShot({ id: 'shot-1', sceneId: 'scene-1' }),
    makeShot({ id: 'shot-2', sceneId: 'scene-1' }),
    makeShot({ id: 'shot-3', sceneId: 'scene-2' }),
  ];
  const frames = [
    makeFrame({ id: 'f1', shotId: 'shot-1' }),
    makeFrame({ id: 'f2', shotId: 'shot-2' }),
    makeFrame({ id: 'f3', shotId: 'shot-3' }),
  ];
  const allStale = () => {
    for (const id of ['shot-1', 'shot-2', 'shot-3'])
      stalenessByShot.set(id, { ...FRESH, visualPrompt: 'stale' });
  };

  it('covers every shot when neither sceneId nor shotId is given', async () => {
    allStale();
    const result = await plan(shots, frames);
    expect(result.targets.map((t) => t.shotId)).toEqual([
      'shot-1',
      'shot-2',
      'shot-3',
    ]);
  });

  it('limits to one scene', async () => {
    allStale();
    const result = await plan(shots, frames, { sceneId: 'scene-1' });
    expect(result.targets.map((t) => t.shotId)).toEqual(['shot-1', 'shot-2']);
  });

  it('lets shotId win over sceneId — a one-shot update never widens', async () => {
    allStale();
    const result = await plan(shots, frames, {
      sceneId: 'scene-1',
      shotId: 'shot-3',
    });
    expect(result.targets.map((t) => t.shotId)).toEqual(['shot-3']);
  });
});

describe('computePlan — durable step-result size', () => {
  it('keeps scene bodies out of the plan (1 MiB step-result cap)', async () => {
    stalenessByShot.set('shot-1', { ...FRESH, motionPrompt: 'stale' });
    const result = await plan(
      [makeShot({ id: 'shot-0' }), makeShot(), makeShot({ id: 'shot-2' })],
      [makeFrame()]
    );
    const target = result.targets[0];
    expect(target).toBeDefined();
    // Neighbours are carried as ids, resolved to scenes per shot at spawn time.
    expect(target).toMatchObject({
      beforeShotId: 'shot-0',
      afterShotId: 'shot-2',
    });
    expect(JSON.stringify(target)).not.toContain('sceneId');
  });
});
