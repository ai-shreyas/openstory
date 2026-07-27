/**
 * Unit tests for the shot↔image projection helpers (#989). These map the
 * anchor frame's `image*` surface back under the legacy `thumbnail*`/`image*`
 * names the UI and realtime cache read, so the client contract stayed stable
 * when the still-image columns moved off `shots` onto `frames`.
 *
 * Asserting the mapping DIRECTLY here matters because the realtime cache tests
 * build their fixtures *with* `projectShotWithImage`, so they can't catch a
 * frame→thumbnail mapping regression on their own.
 */

import type { Frame, Shot } from '@/lib/db/schema';
import { generateMockShots } from '@/lib/mocks/data-generators';
import { describe, expect, it } from 'vitest';
import {
  projectShotMissingFrame,
  projectShotWithImage,
} from './shot-with-image';

// A ShotWithImage is a supertype of Shot, so it stands in for a raw shot row.
function makeShot(): Shot {
  const [base] = generateMockShots(1);
  if (!base) throw new Error('test setup: generateMockShots returned nothing');
  return base;
}

function makeFrame(shot: Shot, overrides: Partial<Frame> = {}): Frame {
  return {
    id: 'frame-id-distinct-from-shot',
    shotId: shot.id,
    sequenceId: shot.sequenceId,
    orderIndex: 0,
    role: 'first',
    source: 'generated',
    imageUrl: 'https://cdn/still.png',
    previewImageUrl: 'https://cdn/preview.png',
    imagePath: 'r2/still.png',
    imageStatus: 'completed',
    imageWorkflowRunId: 'run-123',
    imageGeneratedAt: new Date('2026-06-26T00:00:00Z'),
    imageError: null,
    imageModel: 'flux',
    imagePrompt: 'a prompt',
    selectedImageVersionId: 'ver-1',
    selectedImagePromptVersionId: null,
    pendingPromoteVersionId: null,
    imageInputHash: 'img-hash',
    visualPromptInputHash: 'vp-hash',
    createdAt: shot.createdAt,
    updatedAt: shot.updatedAt,
    ...overrides,
  };
}

describe('projectShotWithImage', () => {
  it('mirrors the anchor frame image surface onto the legacy thumbnail aliases', () => {
    const shot = makeShot();
    const frame = makeFrame(shot);

    const projected = projectShotWithImage(shot, frame, {
      url: 'https://cdn/grid.png',
      status: 'completed',
    });

    expect(projected.thumbnailUrl).toBe(frame.imageUrl);
    expect(projected.previewThumbnailUrl).toBe(frame.previewImageUrl);
    expect(projected.thumbnailPath).toBe(frame.imagePath);
    expect(projected.thumbnailStatus).toBe(frame.imageStatus);
    expect(projected.thumbnailWorkflowRunId).toBe(frame.imageWorkflowRunId);
    expect(projected.thumbnailError).toBe(frame.imageError);
    expect(projected.imageModel).toBe('flux');
    expect(projected.imagePrompt).toBe('a prompt');
    expect(projected.thumbnailInputHash).toBe(frame.imageInputHash);
    expect(projected.visualPromptInputHash).toBe(frame.visualPromptInputHash);
    // The raw frame is carried verbatim for version-aware callers.
    expect(projected.frame).toBe(frame);
  });

  it('maps the grid sheet into variantImage* (3×3 framing surface)', () => {
    const shot = makeShot();
    const frame = makeFrame(shot);

    const projected = projectShotWithImage(shot, frame, {
      url: 'https://cdn/grid.png',
      status: 'generating',
    });

    expect(projected.variantImageUrl).toBe('https://cdn/grid.png');
    expect(projected.variantImageStatus).toBe('generating');
  });

  it('nulls the variantImage surface when there is no grid sheet', () => {
    const shot = makeShot();
    const frame = makeFrame(shot);

    const projected = projectShotWithImage(shot, frame);

    expect(projected.variantImageUrl).toBeNull();
    expect(projected.variantImageStatus).toBeNull();
  });
});

describe('projectShotMissingFrame', () => {
  it('preserves a frameless shot with a null image surface (never drops it)', () => {
    const shot = makeShot();

    const projected = projectShotMissingFrame(shot);

    expect(projected.id).toBe(shot.id);
    expect(projected.thumbnailUrl).toBeNull();
    expect(projected.thumbnailStatus).toBeNull();
    expect(projected.variantImageUrl).toBeNull();
    expect(projected.variantImageStatus).toBeNull();
    // Synthetic placeholder frame: id mirrors the shot (in-memory only) and the
    // column-default model fills the shape.
    expect(projected.frame.shotId).toBe(shot.id);
    expect(projected.imageModel).toBe('nano_banana_2');
  });
});
