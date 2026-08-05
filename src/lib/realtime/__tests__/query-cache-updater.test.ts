/**
 * Tests for `updateQueryCacheFromEvent` — focused on the variant-only guard
 * (#547). An added (alternate) model's image/video completion must NOT repoint
 * the live primary in the shots-list cache; it should only refresh the
 * per-model variant/model-list queries so the new model surfaces in the
 * dropdown. The primary-model path (no `variantOnly`) keeps optimistically
 * writing the primary as before.
 */

import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { promptVariantKeys } from '@/hooks/use-prompt-variants';
import { sceneKeys } from '@/hooks/use-scenes';
import { shotKeys } from '@/hooks/use-shots';
import type { Frame, Shot } from '@/lib/db/schema';
import {
  selectedVersionFixture,
  videoFixtureFor,
} from '@/lib/mocks/frame-fixtures';
import {
  projectShotWithImage,
  type ShotWithImage,
} from '@/lib/shots/shot-with-image';
import { updateQueryCacheFromEvent } from '@/lib/realtime/query-cache-updater';

const SEQ = 'seq-1';
const OLD_THUMB = 'https://cdn/old-thumb.jpg';
const OLD_VIDEO = 'https://cdn/old-video.mp4';
const NEW_URL = 'https://cdn/added-model-output.mp4';

// The shots-list cache holds `ShotWithImage` (#989): a Shot (no image columns)
// plus the anchor frame's still surface projected back under the legacy
// `thumbnail*` DTO names the realtime handlers read/write. Behaviour is
// unchanged — only the type moved.
function makeShot(overrides: Partial<ShotWithImage> = {}): ShotWithImage {
  const shot: Shot = {
    id: 'shot-1',
    sequenceId: SEQ,
    sceneId: null,
    shotNumber: null,
    orderIndex: 0,
    description: 'A scene',
    durationMs: 3000,
    motionPrompt: null,
    selectedMotionPromptVersionId: null,
    renderSegmentId: null,
    motionPromptInputHash: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const frame: Frame = {
    id: 'shot-1',
    shotId: 'shot-1',
    sequenceId: SEQ,
    orderIndex: 0,
    role: 'first',
    previewImageUrl: null,
    imageStatus: 'completed',
    imageWorkflowRunId: null,
    imageError: null,
    imagePrompt: null,
    selectedImageVersionId: 'fv-1',
    selectedImagePromptVersionId: null,
    pendingPromoteVersionId: null,
    visualPromptInputHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  // The still is the selected version, not a frame column (#1067) — and the
  // live video is the selected version of the shot's render segment, not a
  // shot column.
  const selectedVersion = selectedVersionFixture({
    frameId: frame.id,
    sequenceId: SEQ,
    url: OLD_THUMB,
  });
  const selectedVideo = videoFixtureFor({
    id: shot.id,
    sequenceId: SEQ,
    videoUrl: OLD_VIDEO,
    videoPath: null,
    videoGeneratedAt: null,
    videoInputHash: null,
    motionModel: 'veo3',
    durationMs: shot.durationMs,
    createdAt: shot.createdAt,
    updatedAt: shot.updatedAt,
  });
  return {
    ...projectShotWithImage(shot, frame, {
      selectedImage: selectedVersion,
      selectedVideo,
      // That same render is the segment's primary, so the shot reads `completed`.
      primaryVideo: selectedVideo,
    }),
    ...overrides,
  };
}

function getCachedShot(qc: QueryClient): ShotWithImage | undefined {
  return qc.getQueryData<ShotWithImage[]>(shotKeys.list(SEQ))?.[0];
}

describe('updateQueryCacheFromEvent — variant-only guard (#547)', () => {
  let qc: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    qc = new QueryClient();
    qc.setQueryData(shotKeys.list(SEQ), [makeShot()]);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  describe('generation.image:progress', () => {
    it('variant-only completion leaves the primary thumbnail untouched but still refreshes the model/variant queries', () => {
      const invalidate = vi.spyOn(qc, 'invalidateQueries');

      updateQueryCacheFromEvent(qc, SEQ, 'generation.image:progress', {
        shotId: 'shot-1',
        status: 'completed',
        thumbnailUrl: NEW_URL,
        model: 'flux_pro',
        variantOnly: true,
      });

      // Primary shot is NOT repointed to the added model's output.
      const shot = getCachedShot(qc);
      expect(shot?.thumbnailUrl).toBe(OLD_THUMB);
      expect(shot?.thumbnailStatus).toBe('completed');

      // The per-model variant + model-list queries still refresh so the added
      // model appears in the dropdown (debounced — flush the timer).
      vi.advanceTimersByTime(200);
      const invalidatedKeys = invalidate.mock.calls.map((c) => c[0]?.queryKey);
      expect(invalidatedKeys).toContainEqual(['sequence-image-variants', SEQ]);
      expect(invalidatedKeys).toContainEqual(['sequence-image-models', SEQ]);
      // The shots list itself is never invalidated by this handler.
      expect(invalidatedKeys).not.toContainEqual(shotKeys.list(SEQ));
    });

    it('primary completion (no variantOnly) still writes the thumbnail onto the shot', () => {
      updateQueryCacheFromEvent(qc, SEQ, 'generation.image:progress', {
        shotId: 'shot-1',
        status: 'completed',
        thumbnailUrl: NEW_URL,
        model: 'nano_banana_2',
      });

      const shot = getCachedShot(qc);
      expect(shot?.thumbnailUrl).toBe(NEW_URL);
      expect(shot?.thumbnailStatus).toBe('completed');
    });

    it('primary failure writes the reason onto thumbnailError so the banner shows it live (#881)', () => {
      qc.setQueryData(shotKeys.list(SEQ), [
        makeShot({ thumbnailStatus: 'generating', thumbnailError: null }),
      ]);

      updateQueryCacheFromEvent(qc, SEQ, 'generation.image:progress', {
        shotId: 'shot-1',
        status: 'failed',
        model: 'nano_banana_2',
        error: 'Blocked by content filter',
      });

      const shot = getCachedShot(qc);
      expect(shot?.thumbnailStatus).toBe('failed');
      expect(shot?.thumbnailError).toBe('Blocked by content filter');
    });

    it('a fresh generating attempt clears a stale thumbnailError', () => {
      qc.setQueryData(shotKeys.list(SEQ), [
        makeShot({ thumbnailStatus: 'failed', thumbnailError: 'old error' }),
      ]);

      updateQueryCacheFromEvent(qc, SEQ, 'generation.image:progress', {
        shotId: 'shot-1',
        status: 'generating',
        model: 'nano_banana_2',
      });

      expect(getCachedShot(qc)?.thumbnailError).toBeNull();
    });

    it('variant-only failure refreshes the model/variant queries so the coverage marker leaves the spinner', () => {
      const invalidate = vi.spyOn(qc, 'invalidateQueries');

      updateQueryCacheFromEvent(qc, SEQ, 'generation.image:progress', {
        shotId: 'shot-1',
        status: 'failed',
        model: 'flux_pro',
        variantOnly: true,
      });

      // The failed alternate must not flip the primary thumbnail to failed.
      const shot = getCachedShot(qc);
      expect(shot?.thumbnailUrl).toBe(OLD_THUMB);
      expect(shot?.thumbnailStatus).toBe('completed');

      // ...but the per-model queries must refresh so the added model's marker
      // shows `failed` instead of spinning `generating` until staleTime lapses.
      vi.advanceTimersByTime(200);
      const invalidatedKeys = invalidate.mock.calls.map((c) => c[0]?.queryKey);
      expect(invalidatedKeys).toContainEqual(['sequence-image-variants', SEQ]);
      expect(invalidatedKeys).toContainEqual(['sequence-image-models', SEQ]);
    });
  });

  describe('generation.video:progress', () => {
    it('variant-only completion leaves the primary video untouched but still refreshes the model/variant queries', () => {
      const invalidate = vi.spyOn(qc, 'invalidateQueries');

      updateQueryCacheFromEvent(qc, SEQ, 'generation.video:progress', {
        shotId: 'shot-1',
        status: 'completed',
        videoUrl: NEW_URL,
        model: 'kling_25',
        variantOnly: true,
      });

      const shot = getCachedShot(qc);
      expect(shot?.videoUrl).toBe(OLD_VIDEO);
      expect(shot?.videoStatus).toBe('completed');

      vi.advanceTimersByTime(200);
      const invalidatedKeys = invalidate.mock.calls.map((c) => c[0]?.queryKey);
      expect(invalidatedKeys).toContainEqual(['sequence-video-variants', SEQ]);
      expect(invalidatedKeys).toContainEqual(['sequence-video-models', SEQ]);
      // Video tab version chips read segments — must refresh with history (#1076).
      expect(invalidatedKeys).toContainEqual(['segments', 'list', SEQ]);
    });

    it('primary completion refreshes segments so version chips leave the spinning state (#1076)', () => {
      const invalidate = vi.spyOn(qc, 'invalidateQueries');
      qc.setQueryData(shotKeys.list(SEQ), [
        makeShot({ videoStatus: 'generating', videoError: null }),
      ]);

      updateQueryCacheFromEvent(qc, SEQ, 'generation.video:progress', {
        shotId: 'shot-1',
        status: 'completed',
        videoUrl: NEW_URL,
        model: 'veo3',
      });

      expect(getCachedShot(qc)?.videoStatus).toBe('completed');

      vi.advanceTimersByTime(200);
      const invalidatedKeys = invalidate.mock.calls.map((c) => c[0]?.queryKey);
      expect(invalidatedKeys).toContainEqual(['segments', 'list', SEQ]);
      expect(invalidatedKeys).toContainEqual([
        ...shotKeys.videoVersions('shot-1'),
      ]);
    });

    it('variant-only failure does not flip the primary video to failed', () => {
      updateQueryCacheFromEvent(qc, SEQ, 'generation.video:progress', {
        shotId: 'shot-1',
        status: 'failed',
        model: 'kling_25',
        variantOnly: true,
      });

      const shot = getCachedShot(qc);
      expect(shot?.videoStatus).toBe('completed');
      expect(shot?.videoUrl).toBe(OLD_VIDEO);
    });

    it('primary completion (no variantOnly) still writes the video onto the shot', () => {
      updateQueryCacheFromEvent(qc, SEQ, 'generation.video:progress', {
        shotId: 'shot-1',
        status: 'completed',
        videoUrl: NEW_URL,
        model: 'veo3',
      });

      const shot = getCachedShot(qc);
      expect(shot?.videoUrl).toBe(NEW_URL);
      expect(shot?.videoStatus).toBe('completed');
    });

    it('primary failure writes the reason onto videoError so the banner shows it live (#881)', () => {
      qc.setQueryData(shotKeys.list(SEQ), [
        makeShot({ videoStatus: 'generating', videoError: null }),
      ]);

      updateQueryCacheFromEvent(qc, SEQ, 'generation.video:progress', {
        shotId: 'shot-1',
        status: 'failed',
        model: 'veo3',
        error: 'Motion generation rejected by content filter',
      });

      const shot = getCachedShot(qc);
      expect(shot?.videoStatus).toBe('failed');
      expect(shot?.videoError).toBe(
        'Motion generation rejected by content filter'
      );
    });
  });

  // After #713 the regenerated prompt no longer rides in `metadata` — it's
  // mirrored onto the frame/shot and projected server-side. The handler must
  // refetch the shots list (re-runs that projection) and the version-history
  // query, instead of relying on the now-inert in-place metadata patch (#991).
  describe('generation.shot:updated (prompt regeneration #991)', () => {
    it('visual-prompt refetches the shots list and the visual history query', () => {
      const invalidate = vi.spyOn(qc, 'invalidateQueries');

      updateQueryCacheFromEvent(qc, SEQ, 'generation.shot:updated', {
        shotId: 'shot-1',
        updateType: 'visual-prompt',
        metadata: { sceneId: 'sc-1', sceneNumber: 1 },
      });

      vi.advanceTimersByTime(200);
      const keys = invalidate.mock.calls.map((c) => c[0]?.queryKey);
      expect(keys).toContainEqual(shotKeys.list(SEQ));
      expect(keys).toContainEqual(promptVariantKeys.shot('visual', 'shot-1'));
    });

    it('motion-prompt refetches the shots list and the motion history query', () => {
      const invalidate = vi.spyOn(qc, 'invalidateQueries');

      updateQueryCacheFromEvent(qc, SEQ, 'generation.shot:updated', {
        shotId: 'shot-1',
        updateType: 'motion-prompt',
        metadata: { sceneId: 'sc-1', sceneNumber: 1 },
      });

      vi.advanceTimersByTime(200);
      const keys = invalidate.mock.calls.map((c) => c[0]?.queryKey);
      expect(keys).toContainEqual(shotKeys.list(SEQ));
      expect(keys).toContainEqual(promptVariantKeys.shot('motion', 'shot-1'));
    });

    it('a non-prompt updateType patches metadata in place without refetching the list', () => {
      const invalidate = vi.spyOn(qc, 'invalidateQueries');

      updateQueryCacheFromEvent(qc, SEQ, 'generation.shot:updated', {
        shotId: 'shot-1',
        updateType: 'music-design',
        metadata: { sceneId: 'sc-1', sceneNumber: 2 },
      });

      // Music/audio design still travels in metadata — patched in place, no
      // refetch.
      expect(getCachedShot(qc)?.metadata?.sceneNumber).toBe(2);
      vi.advanceTimersByTime(200);
      const keys = invalidate.mock.calls.map((c) => c[0]?.queryKey);
      expect(keys).not.toContainEqual(shotKeys.list(SEQ));
      expect(keys).not.toContainEqual(
        promptVariantKeys.shot('visual', 'shot-1')
      );
    });
  });

  // Stream-time scene persistence (#1072): each analysis scene writes a
  // `scenes` row + links the shot, so the spine must refetch scenes (and
  // shots) as soon as those events land — not only after bulk persist-scenes.
  describe('generation.scene / shot creation invalidates scenes list (#1072)', () => {
    it('generation.shot:created refetches shots and scenes', () => {
      const invalidate = vi.spyOn(qc, 'invalidateQueries');

      updateQueryCacheFromEvent(qc, SEQ, 'generation.shot:created', {
        shotId: 'shot-1',
        sceneId: 'analysis-1',
        orderIndex: 0,
      });

      vi.advanceTimersByTime(200);
      const keys = invalidate.mock.calls.map((c) => c[0]?.queryKey);
      expect(keys).toContainEqual(shotKeys.list(SEQ));
      expect(keys).toContainEqual(sceneKeys.list(SEQ));
    });

    it('generation.scene:new refetches scenes and shots', () => {
      const invalidate = vi.spyOn(qc, 'invalidateQueries');

      updateQueryCacheFromEvent(qc, SEQ, 'generation.scene:new', {
        sceneId: 'analysis-1',
        sceneNumber: 1,
        title: 'Opening',
      });

      vi.advanceTimersByTime(200);
      const keys = invalidate.mock.calls.map((c) => c[0]?.queryKey);
      expect(keys).toContainEqual(sceneKeys.list(SEQ));
      expect(keys).toContainEqual(shotKeys.list(SEQ));
    });

    it('generation.scene:updated refetches scenes and shots', () => {
      const invalidate = vi.spyOn(qc, 'invalidateQueries');

      updateQueryCacheFromEvent(qc, SEQ, 'generation.scene:updated', {
        sceneId: 'sc-1',
        title: 'New title',
      });

      // Titles render off the scenes query, so refetching it IS the update.
      vi.advanceTimersByTime(200);
      const keys = invalidate.mock.calls.map((c) => c[0]?.queryKey);
      expect(keys).toContainEqual(sceneKeys.list(SEQ));
      expect(keys).toContainEqual(shotKeys.list(SEQ));
    });
  });
});
