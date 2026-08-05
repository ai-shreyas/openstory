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

import type { Frame, FrameVariant, Shot, VideoVariant } from '@/lib/db/schema';
import { generateMockShots } from '@/lib/mocks/data-generators';
import { videoFixtureFor } from '@/lib/mocks/frame-fixtures';
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

/** The `video_variants` row the shot's render segment points at. */
function makeVideo(shot: Shot): VideoVariant {
  const video = videoFixtureFor({
    id: shot.id,
    sequenceId: shot.sequenceId,
    videoUrl: 'https://cdn/render.mp4',
    videoPath: 'r2/render.mp4',
    videoGeneratedAt: new Date('2026-06-27T00:00:00Z'),
    videoInputHash: 'vid-hash',
    motionModel: 'kling_25_turbo_pro',
    durationMs: shot.durationMs,
    createdAt: shot.createdAt,
    updatedAt: shot.updatedAt,
  });
  if (!video) throw new Error('test setup: videoFixtureFor returned null');
  return video;
}

describe('projectShotWithImage', () => {
  it('projects the still off the SELECTED version, not the frame (#1067)', () => {
    const shot = makeShot();
    const frame = makeFrame(shot);
    const version = makeVersion(shot);

    const promptVersion = {
      id: 'fpv-1',
      frameId: frame.id,
      text: 'a prompt',
      components: null,
      source: 'ai-generated' as const,
      inputHash: 'visual-hash',
      analysisModel: null,
      status: 'completed' as const,
      pendingInputHash: null,
      workflowRunId: null,
      createdAt: new Date(),
      createdBy: null,
    };

    const projected = projectShotWithImage(shot, frame, {
      selectedImage: version,
      selectedImagePrompt: promptVersion,
      selectedVideo: null,
      primaryVideo: null,
      gridSheet: { url: 'https://cdn/grid.png', status: 'completed' },
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
    // The prompt and its hash come from the selected prompt version, not the frame.
    expect(projected.imagePrompt).toBe('a prompt');
    expect(projected.visualPromptInputHash).toBe('visual-hash');
    // The raw frame is carried verbatim for version-aware callers.
    expect(projected.frame).toBe(frame);
  });

  it('nulls the still when the frame has no selected version', () => {
    const shot = makeShot();
    const frame = makeFrame(shot, { selectedImageVersionId: null });

    const projected = projectShotWithImage(shot, frame, {
      selectedImage: null,
      selectedImagePrompt: null,
      selectedVideo: null,
      primaryVideo: null,
    });

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

    const projected = projectShotWithImage(shot, frame, {
      selectedImage: makeVersion(shot),
      selectedImagePrompt: null,
      selectedVideo: null,
      primaryVideo: null,
      gridSheet: { url: 'https://cdn/grid.png', status: 'generating' },
    });

    expect(projected.variantImageUrl).toBe('https://cdn/grid.png');
    expect(projected.variantImageStatus).toBe('generating');
  });

  it('nulls the variantImage surface when there is no grid sheet', () => {
    const shot = makeShot();
    const frame = makeFrame(shot);

    const projected = projectShotWithImage(shot, frame, {
      selectedImage: makeVersion(shot),
      selectedImagePrompt: null,
      selectedVideo: null,
      primaryVideo: null,
    });

    expect(projected.variantImageUrl).toBeNull();
    expect(projected.variantImageStatus).toBeNull();
  });

  // The video surface moved off `shots` the same way the still did (#1067
  // phase 2d) — and for the same reason as the block comment above, every
  // other suite builds its shots THROUGH this projection, so a video→shot
  // mapping regression is only visible here.
  it('projects the video off the segment’s SELECTED version (#1067)', () => {
    const shot = makeShot();
    const frame = makeFrame(shot);
    const video = makeVideo(shot);

    const projected = projectShotWithImage(shot, frame, {
      selectedImage: makeVersion(shot),
      selectedImagePrompt: null,
      selectedVideo: video,
      primaryVideo: null,
    });

    expect(projected.videoUrl).toBe(video.url);
    expect(projected.videoPath).toBe(video.storagePath);
    expect(projected.videoGeneratedAt).toBe(video.generatedAt);
    expect(projected.videoInputHash).toBe(video.inputHash);
    expect(projected.motionModel).toBe('kling_25_turbo_pro');
    // A selection with no primary render behind it (a backfilled row) still
    // reads as completed — the pointer is the fallback lifecycle.
    expect(projected.videoStatus).toBe('completed');
    expect(projected.videoError).toBeNull();
    expect(projected.videoWorkflowRunId).toBeNull();
  });

  it('takes the lifecycle from the newest PRIMARY render, not the selection', () => {
    // Re-rolling over a good video must read `generating` while the selected
    // (previous) render keeps playing.
    const shot = makeShot();
    const frame = makeFrame(shot);
    const selected = makeVideo(shot);
    const primary: VideoVariant = {
      ...selected,
      id: 'vv-inflight',
      url: null,
      storagePath: null,
      status: 'generating',
      error: null,
      workflowRunId: 'run-motion-1',
    };

    const projected = projectShotWithImage(shot, frame, {
      selectedImage: makeVersion(shot),
      selectedImagePrompt: null,
      selectedVideo: selected,
      primaryVideo: primary,
    });

    expect(projected.videoStatus).toBe('generating');
    expect(projected.videoWorkflowRunId).toBe('run-motion-1');
    expect(projected.videoUrl).toBe(selected.url);
  });

  it('surfaces the primary render’s failure over the selected version', () => {
    const shot = makeShot();
    const frame = makeFrame(shot);
    const primary: VideoVariant = {
      ...makeVideo(shot),
      id: 'vv-failed',
      url: null,
      storagePath: null,
      status: 'failed',
      error: 'fal 500',
    };

    const projected = projectShotWithImage(shot, frame, {
      selectedImage: makeVersion(shot),
      selectedImagePrompt: null,
      selectedVideo: null,
      primaryVideo: primary,
    });

    expect(projected.videoStatus).toBe('failed');
    expect(projected.videoError).toBe('fal 500');
    expect(projected.videoUrl).toBeNull();
  });

  it('nulls the video surface when the segment has no selected version', () => {
    const shot = makeShot();
    const frame = makeFrame(shot);

    const projected = projectShotWithImage(shot, frame, {
      selectedImage: makeVersion(shot),
      selectedImagePrompt: null,
      selectedVideo: null,
      primaryVideo: null,
    });

    expect(projected.videoUrl).toBeNull();
    expect(projected.videoPath).toBeNull();
    expect(projected.videoGeneratedAt).toBeNull();
    expect(projected.videoInputHash).toBeNull();
    // Like imageModel: null, NOT a default — nothing was ever rendered.
    expect(projected.motionModel).toBeNull();
    expect(projected.videoStatus).toBeNull();
  });
});

describe('projectShotMissingFrame', () => {
  it('preserves a frameless shot with a null image surface (never drops it)', () => {
    const shot = makeShot();

    const projected = projectShotMissingFrame(shot, {
      selectedVideo: null,
      primaryVideo: null,
    });

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

  it('still projects the video surface — it hangs off the segment, not the frame', () => {
    const shot = makeShot();
    const video = makeVideo(shot);

    const projected = projectShotMissingFrame(shot, {
      selectedVideo: video,
      primaryVideo: video,
    });

    expect(projected.videoUrl).toBe(video.url);
    expect(projected.motionModel).toBe('kling_25_turbo_pro');
    expect(projected.videoStatus).toBe('completed');
    expect(projected.thumbnailUrl).toBeNull();
  });
});
