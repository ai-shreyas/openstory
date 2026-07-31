import { describe, expect, it, vi } from 'vitest';
import type { Scene } from '@/lib/ai/scene-analysis.schema';
import type { Frame, Shot } from '@/lib/db/schema';
import type { ScopedDb } from '@/lib/db/scoped';

const buildRegenerateShotSnapshot = vi.fn();
const loadNarrowShotPromptContext = vi.fn();
const computeVisualPromptInputHash = vi.fn();
const computeMotionPromptInputHash = vi.fn();

vi.doMock('@/lib/workflows/regenerate-shots-snapshot', () => ({
  buildRegenerateShotSnapshot,
}));
vi.doMock('@/lib/ai/prompt-context', () => ({ loadNarrowShotPromptContext }));
vi.doMock('@/lib/ai/input-hash', () => ({
  computeVisualPromptInputHash,
  computeMotionPromptInputHash,
}));

const { computeShotStaleness } = await import('./shot-staleness');

// Shape-matching stubs: each fixture carries only what this module reads, so a
// future field read fails loudly rather than silently seeing `undefined`.
// Same pattern as `sheet-snapshots.test.ts`.
function asStub<T>(stub: unknown): T {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test stub
  return stub as T;
}

const scene = asStub<Scene>({ sceneId: 'scene-1' });
const sequence = {
  id: 'seq-1',
  styleId: 'style-1',
  aspectRatio: '16:9',
  analysisModel: 'model-1',
} as const;

/** `null` cached hashes force the `getLatestWithInputHash` fallback path. */
function makeScopedDb(overrides: {
  visualFallbackHash?: string | null;
  motionFallbackHash?: string | null;
}) {
  return asStub<ScopedDb>({
    characters: { listWithSheets: vi.fn().mockResolvedValue([]) },
    sequenceLocations: { listWithReferences: vi.fn().mockResolvedValue([]) },
    sequenceElements: { list: vi.fn().mockResolvedValue([]) },
    styles: { getById: vi.fn().mockResolvedValue({ config: {} }) },
    framePromptVersions: {
      getLatest: vi.fn().mockResolvedValue(null),
      getLatestWithInputHash: vi
        .fn()
        .mockResolvedValue(
          overrides.visualFallbackHash
            ? { inputHash: overrides.visualFallbackHash }
            : null
        ),
    },
    shotPromptVersions: {
      getLatest: vi.fn().mockResolvedValue(null),
      getLatestWithInputHash: vi
        .fn()
        .mockResolvedValue(
          overrides.motionFallbackHash
            ? { inputHash: overrides.motionFallbackHash }
            : null
        ),
    },
  });
}

const shot = asStub<Shot>({
  id: 'shot-1',
  motionPromptInputHash: 'motion-stored',
});
const frame = asStub<Frame>({
  id: 'frame-1',
  imagePrompt: 'a prompt',
  imageInputHash: 'image-stored',
  imageModel: null,
  imageUrl: null,
  visualPromptInputHash: 'visual-stored',
});

describe('computeShotStaleness', () => {
  it('reports a failed branch as unknown without taking the others down', async () => {
    // Thumbnail hashing blows up; the two prompt branches must still report.
    buildRegenerateShotSnapshot.mockRejectedValue(new Error('boom'));
    loadNarrowShotPromptContext.mockResolvedValue({});
    computeVisualPromptInputHash.mockResolvedValue('visual-stored');
    computeMotionPromptInputHash.mockResolvedValue('motion-moved');

    const result = await computeShotStaleness({
      scopedDb: makeScopedDb({}),
      sequence,
      shot,
      frame,
      scene,
    });

    expect(result).toEqual({
      thumbnail: 'unknown',
      visualPrompt: 'fresh',
      motionPrompt: 'stale',
    });
  });

  it('falls back to the latest version hash when the cached column is null', async () => {
    buildRegenerateShotSnapshot.mockResolvedValue({
      snapshotInputHash: 'image-stored',
    });
    loadNarrowShotPromptContext.mockResolvedValue({});
    computeVisualPromptInputHash.mockResolvedValue('visual-moved');
    computeMotionPromptInputHash.mockResolvedValue('motion-moved');

    const result = await computeShotStaleness({
      scopedDb: makeScopedDb({
        visualFallbackHash: 'visual-stored',
        motionFallbackHash: 'motion-stored',
      }),
      sequence,
      shot: { ...shot, motionPromptInputHash: null },
      frame: { ...frame, visualPromptInputHash: null },
      scene,
    });

    // Without the fallback both would be stuck at 'untracked' forever.
    expect(result).toEqual({
      thumbnail: 'fresh',
      visualPrompt: 'stale',
      motionPrompt: 'stale',
    });
  });
});
