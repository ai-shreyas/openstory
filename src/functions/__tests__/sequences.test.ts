/**
 * Tests for the pure decision helpers extracted from the add-model /
 * set-model server fns (#547). The TanStack server-fn middleware chain (auth,
 * sequence access, scoped DB, workflow triggers) is exercised end-to-end by the
 * e2e suite; here we pin the logic that decides:
 *   - the duplicate-model guard (`assertModelNotAlreadyAdded`) — a failed add
 *     must be re-addable,
 *   - the video eligibility filter (`selectEligibleVideoShots`).
 */

import { describe, expect, it } from 'vitest';
import type { Frame, Shot } from '@/lib/db/schema';
import { selectedVersionFixture } from '@/lib/mocks/frame-fixtures';
import {
  projectShotWithImage,
  type ShotWithImage,
} from '@/lib/shots/shot-with-image';
import {
  assertModelNotAlreadyAdded,
  buildAddAudioMusicInput,
  musicWithoutMotion,
  selectEligibleVideoShots,
  sumShotDurationsSeconds,
} from '@/functions/sequences';

const NOW = new Date('2026-06-03T00:00:00.000Z');

// The shot read path returns `ShotWithImage` (#989): a Shot (no image columns)
// plus the anchor frame's still surface projected back under the legacy
// `thumbnail*`/`image*` names. The image-readiness helpers below read those
// projected names, so the fixtures carry them.
function makeShot(overrides: Partial<ShotWithImage> = {}): ShotWithImage {
  const id = overrides.id ?? 'shot-1';
  const sequenceId = overrides.sequenceId ?? 'seq-1';
  const shot: Shot = {
    id,
    sequenceId,
    sceneId: null,
    shotNumber: null,
    orderIndex: 0,
    durationMs: 3000,
    motionPrompt: null,
    selectedMotionPromptVersionId: null,
    renderSegmentId: null,
    motionPromptInputHash: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const frame: Frame = {
    id,
    shotId: id,
    sequenceId,
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
    createdAt: NOW,
    updatedAt: NOW,
  };
  // The still is the selected version, not a frame column (#1067).
  const selectedVersion = selectedVersionFixture({
    frameId: frame.id,
    sequenceId,
    url: 'https://cdn/thumb.jpg',
  });
  return {
    // These fixtures exercise the IMAGE-readiness helpers only, so the shot's
    // segment has no render at all (#1067).
    ...projectShotWithImage(shot, frame, {
      selectedImage: selectedVersion,
      selectedVideo: null,
      primaryVideo: null,
    }),
    ...overrides,
  };
}

describe('assertModelNotAlreadyAdded (#547)', () => {
  it('throws when a non-failed row exists for the model', () => {
    for (const status of ['pending', 'generating', 'completed']) {
      expect(() =>
        assertModelNotAlreadyAdded(
          [{ model: 'flux_pro', status }],
          'flux_pro',
          'image'
        )
      ).toThrow(/already on this sequence/);
    }
  });

  it('does NOT throw when only a failed row exists (re-add is allowed)', () => {
    expect(() =>
      assertModelNotAlreadyAdded(
        [{ model: 'flux_pro', status: 'failed' }],
        'flux_pro',
        'image'
      )
    ).not.toThrow();
  });

  it('does NOT throw when no row exists for the model', () => {
    expect(() =>
      assertModelNotAlreadyAdded(
        [{ model: 'other', status: 'completed' }],
        'flux_pro',
        'video'
      )
    ).not.toThrow();
  });

  it('uses the label in the error message', () => {
    expect(() =>
      assertModelNotAlreadyAdded(
        [{ model: 'suno', status: 'completed' }],
        'suno',
        'audio'
      )
    ).toThrow('That audio model is already on this sequence');
  });
});

describe('selectEligibleVideoShots (#547)', () => {
  it('includes shots with a completed image', () => {
    const shots = [makeShot()];
    expect(selectEligibleVideoShots(shots)).toHaveLength(1);
  });

  it('excludes shots whose image is not completed', () => {
    const shots = [
      makeShot({ id: 'pending', thumbnailStatus: 'pending' }),
      makeShot({ id: 'generating', thumbnailStatus: 'generating' }),
      makeShot({ id: 'failed', thumbnailStatus: 'failed' }),
    ];
    expect(selectEligibleVideoShots(shots)).toEqual([]);
  });

  it('excludes shots completed but missing a thumbnail url', () => {
    const shots = [
      makeShot({ id: 'null-url', thumbnailUrl: null }),
      makeShot({ id: 'empty-url', thumbnailUrl: '' }),
    ];
    expect(selectEligibleVideoShots(shots)).toEqual([]);
  });

  it('returns only the eligible shots from a mixed set', () => {
    const shots = [
      makeShot({ id: 'ok-1' }),
      makeShot({ id: 'no-image', thumbnailStatus: 'pending' }),
      makeShot({ id: 'ok-2' }),
    ];
    expect(selectEligibleVideoShots(shots).map((f) => f.id)).toEqual([
      'ok-1',
      'ok-2',
    ]);
  });
});

describe('sumShotDurationsSeconds (#547)', () => {
  it('sums durationMs (ms → seconds) across shots', () => {
    const shots = [
      makeShot({ id: 'f1', durationMs: 3000 }),
      makeShot({ id: 'f2', durationMs: 4500 }),
    ];
    expect(sumShotDurationsSeconds(shots)).toBe(7.5);
  });

  it('falls back to 10s per shot when durationMs is absent', () => {
    const shots = [
      makeShot({ id: 'unknown-1', durationMs: null }),
      makeShot({ id: 'unknown-2', durationMs: null }),
    ];
    expect(sumShotDurationsSeconds(shots)).toBe(20);
  });

  it('returns 0 for an empty sequence (so the caller `|| 30` floor applies)', () => {
    expect(sumShotDurationsSeconds([])).toBe(0);
    // Mirrors the add-audio / generate-music call sites.
    expect(sumShotDurationsSeconds([]) || 30).toBe(30);
  });
});

describe('buildAddAudioMusicInput (#547)', () => {
  const baseCtx = { userId: 'u1', teamId: 't1', sequenceId: 'seq-1' };

  it('always sets isPrimary:false so an added audio model never repoints the primary track', () => {
    const input = buildAddAudioMusicInput({
      baseCtx,
      prompt: 'epic score',
      tags: 'cinematic',
      durationSeconds: 42,
      model: 'elevenlabs_music',
    });
    // The regression guard: the music workflow defaults isPrimary to true, which
    // would clobber the live sequences.music* columns on success AND failure.
    expect(input.isPrimary).toBe(false);
  });

  it('threads the context, prompt, tags, duration and model through unchanged', () => {
    const input = buildAddAudioMusicInput({
      baseCtx,
      prompt: 'epic score',
      tags: 'cinematic',
      durationSeconds: 42,
      model: 'elevenlabs_music',
    });
    expect(input).toEqual({
      userId: 'u1',
      teamId: 't1',
      sequenceId: 'seq-1',
      prompt: 'epic score',
      tags: 'cinematic',
      duration: 42,
      model: 'elevenlabs_music',
      isPrimary: false,
    });
  });
});

describe('musicWithoutMotion (#823)', () => {
  const flags = (autoGenerateMusic: boolean, autoGenerateMotion: boolean) => ({
    autoGenerateMusic,
    autoGenerateMotion,
  });

  it('rejects an update that sets music on while motion is off', () => {
    expect(musicWithoutMotion(flags(true, false), flags(false, false))).toBe(
      true
    );
  });

  it('rejects music set alone onto a motion-off sequence', () => {
    expect(
      musicWithoutMotion({ autoGenerateMusic: true }, flags(false, false))
    ).toBe(true);
  });

  it('rejects motion turned off while music stays on', () => {
    expect(
      musicWithoutMotion({ autoGenerateMotion: false }, flags(true, true))
    ).toBe(true);
  });

  it('accepts music set alone when motion is already on', () => {
    expect(
      musicWithoutMotion({ autoGenerateMusic: true }, flags(false, true))
    ).toBe(false);
  });

  it('accepts an update that leaves both flags untouched', () => {
    expect(musicWithoutMotion({}, flags(false, false))).toBe(false);
    expect(musicWithoutMotion({}, flags(true, true))).toBe(false);
  });

  it('accepts turning music off regardless of motion', () => {
    expect(
      musicWithoutMotion({ autoGenerateMusic: false }, flags(true, false))
    ).toBe(false);
  });
});
