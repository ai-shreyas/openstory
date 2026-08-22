import type { Shot } from '@/lib/db/schema';
import {
  frameFixture,
  frameVariantFixture,
  videoVariantFixture,
} from '@/lib/mocks/frame-fixtures';
import { toShotView } from '@/lib/shots/shot-view';
import { describe, expect, it } from 'vitest';
import {
  isBrowserDisplayableStillUrl,
  shotAfterVariantSelect,
} from './variant-select-preview';

describe('isBrowserDisplayableStillUrl', () => {
  it('rejects Cloudflare trim URLs that 404 off the edge', () => {
    expect(
      isBrowserDisplayableStillUrl(
        '/cdn-cgi/image/trim=0;1;2;3/r2/thumbnails/x.png'
      )
    ).toBe(false);
    expect(
      isBrowserDisplayableStillUrl(
        'https://storage.example.com/cdn-cgi/image/trim=1;2;3;4/thumbnails/x.png'
      )
    ).toBe(false);
  });

  it('accepts origin-relative R2, blob, and ordinary https URLs', () => {
    expect(isBrowserDisplayableStillUrl('/r2/thumbnails/tile.png')).toBe(true);
    expect(isBrowserDisplayableStillUrl('blob:http://localhost/abc')).toBe(
      true
    );
    expect(isBrowserDisplayableStillUrl('https://v3b.fal.media/x.png')).toBe(
      true
    );
  });
});

describe('shotAfterVariantSelect', () => {
  const now = new Date('2026-06-26T00:00:00Z');
  const shotRow: Shot = {
    id: 'shot-1',
    sequenceId: 'seq-1',
    sceneId: null,
    shotNumber: 1,
    durationMs: 3000,
    selectedMotionPromptVersionId: null,
    renderSegmentId: 'seg-1',
    createdAt: now,
    updatedAt: now,
  };
  const frame = frameFixture({
    shotId: 'shot-1',
    sequenceId: 'seq-1',
    imageStatus: 'completed',
  });
  const video = videoVariantFixture({
    id: 'vid-1',
    renderSegmentId: 'seg-1',
    sequenceId: 'seq-1',
    url: 'https://cdn/old.mp4',
  });
  const shot = toShotView(shotRow, frame, {
    image: frameVariantFixture({
      frameId: frame.id,
      sequenceId: 'seq-1',
      url: 'https://cdn/old-still.png',
    }),
    preview: null,
    imagePromptVersion: null,
    video,
    primaryVideo: video,
    gridSheet: { url: '/r2/thumbnails/grid.png', status: 'completed' },
  });

  it('swaps the still, marks generating, and drops the old video', () => {
    const next = shotAfterVariantSelect(shot, '/r2/thumbnails/tile.png');
    expect(next.image?.url).toBe('/r2/thumbnails/tile.png');
    expect(next.frame.imageStatus).toBe('generating');
    expect(next.video).toBeNull();
    expect(next.videoStatus).toBe('pending');
  });

  it('keeps the current still when no preview url is ready yet', () => {
    const next = shotAfterVariantSelect(shot, undefined);
    expect(next.image?.url).toBe('https://cdn/old-still.png');
    expect(next.frame.imageStatus).toBe('generating');
    expect(next.video).toBeNull();
  });
});
