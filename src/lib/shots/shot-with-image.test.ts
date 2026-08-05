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

import type { Frame, FrameVariant, Shot } from '@/lib/db/schema';
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
    previewImageUrl: 'https://cdn/preview.png',
    imageStatus: 'completed',
    imageWorkflowRunId: 'run-123',
    imageError: null,
    imagePrompt: 'a prompt',
    selectedImageVersionId: 'ver-1',
    selectedImagePromptVersionId: null,
    pendingPromoteVersionId: null,
    visualPromptInputHash: 'vp-hash',
    createdAt: shot.createdAt,
    updatedAt: shot.updatedAt,
    ...overrides,
  };
}

/** The version `makeFrame`'s `selectedImageVersionId` points at. */
function makeVersion(
  shot: Shot,
  overrides: Partial<FrameVariant> = {}
): FrameVariant {
  return {
    id: 'ver-1',
    frameId: 'frame-id-distinct-from-shot',
    sequenceId: shot.sequenceId,
    kind: 'model',
    model: 'flux',
    sourceVariantId: null,
    url: 'https://cdn/still.png',
    storagePath: 'r2/still.png',
    previewUrl: null,
    status: 'completed',
    workflowRunId: 'run-123',
    generatedAt: new Date('2026-06-26T00:00:00Z'),
    error: null,
    promptHash: null,
    inputHash: 'img-hash',
    pendingInputHash: null,
    dependsOnVersionId: null,
    promptVersionId: null,
    discardedAt: null,
    createdAt: shot.createdAt,
    updatedAt: shot.updatedAt,
    ...overrides,
  };
}

describe('projectShotWithImage', () => {
  it('projects the still off the SELECTED version, not the frame (#1067)', () => {
    const shot = makeShot();
    const frame = makeFrame(shot);
    const version = makeVersion(shot);

    const projected = projectShotWithImage(shot, frame, version, {
      url: 'https://cdn/grid.png',
      status: 'completed',
    });

    // From the version — the row that recorded the generation.
    expect(projected.thumbnailUrl).toBe(version.url);
    expect(projected.thumbnailPath).toBe(version.storagePath);
    expect(projected.imageModel).toBe('flux');
    expect(projected.thumbnailInputHash).toBe(version.inputHash);
    // Frame-owned: the preview stand-in and the primary render's lifecycle.
    expect(projected.previewThumbnailUrl).toBe(frame.previewImageUrl);
    expect(projected.thumbnailStatus).toBe(frame.imageStatus);
    expect(projected.thumbnailWorkflowRunId).toBe(frame.imageWorkflowRunId);
    expect(projected.thumbnailError).toBe(frame.imageError);
    expect(projected.imagePrompt).toBe('a prompt');
    expect(projected.visualPromptInputHash).toBe(frame.visualPromptInputHash);
    // The raw frame is carried verbatim for version-aware callers.
    expect(projected.frame).toBe(frame);
  });

  it('nulls the still when the frame has no selected version', () => {
    const shot = makeShot();
    const frame = makeFrame(shot, { selectedImageVersionId: null });

    const projected = projectShotWithImage(shot, frame, null);

    expect(projected.thumbnailUrl).toBeNull();
    expect(projected.thumbnailPath).toBeNull();
    expect(projected.thumbnailInputHash).toBeNull();
    // imageModel must be null, NOT a default — a frame that never generated
    // has no model anyone chose (see resolve-asset-models).
    expect(projected.imageModel).toBeNull();
    // The preview stand-in survives: it is not part of the selection.
    expect(projected.previewThumbnailUrl).toBe('https://cdn/preview.png');
  });

  it('maps the grid sheet into variantImage* (3×3 framing surface)', () => {
    const shot = makeShot();
    const frame = makeFrame(shot);

    const projected = projectShotWithImage(shot, frame, makeVersion(shot), {
      url: 'https://cdn/grid.png',
      status: 'generating',
    });

    expect(projected.variantImageUrl).toBe('https://cdn/grid.png');
    expect(projected.variantImageStatus).toBe('generating');
  });

  it('nulls the variantImage surface when there is no grid sheet', () => {
    const shot = makeShot();
    const frame = makeFrame(shot);

    const projected = projectShotWithImage(shot, frame, makeVersion(shot));

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
    // Synthetic placeholder frame: id mirrors the shot (in-memory only). No
    // selected version → no model, rather than a made-up default (#1067).
    expect(projected.frame.shotId).toBe(shot.id);
    expect(projected.imageModel).toBeNull();
  });
});
