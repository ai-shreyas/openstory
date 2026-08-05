/**
 * Behavioural test for the upscale select step (#989).
 *
 * `selectShotVariantFn` no longer writes the still synchronously — it triggers
 * this workflow, which upscales the chosen 3×3 tile and then REPOINTS the
 * frame's primary still at the upscaled version (pointer + mirror via
 * `frameVariants.select`). The e2e suite can't observe that async repoint
 * hermetically, so the outcome is pinned here: `persistUpscaleSelection`
 * completes the in-flight version and repoints the frame — skipping the repoint
 * (but still completing the version) if the anchor frame vanished mid-flight.
 *
 * The new still no longer drops the segment's chosen render (#1067 phase 2d):
 * the old video keeps playing and the manifest-staleness system flags it.
 */

import type { NewFrameVariant, NewShot } from '@/lib/db/schema';
import { describe, expect, it } from 'vitest';
import {
  persistUpscaleSelection,
  type PersistUpscaleScopedDb,
} from './upscale-shot-variant-workflow';

type VariantUpdateCall = { versionId: string; data: Partial<NewFrameVariant> };
type SelectCall = {
  frameId: string;
  versionId: string;
  actorId: string | null;
};
type ShotUpdateCall = { shotId: string; data: Partial<NewShot> };
type CallName =
  | 'frameVariants.update'
  | 'frames.getAnchorByShot'
  | 'frameVariants.select'
  | 'shots.update';

function buildScopedDbSpy(opts: { anchorMissing?: boolean } = {}): {
  scopedDb: PersistUpscaleScopedDb;
  variantUpdates: VariantUpdateCall[];
  selects: SelectCall[];
  shotUpdates: ShotUpdateCall[];
  callOrder: CallName[];
} {
  const variantUpdates: VariantUpdateCall[] = [];
  const selects: SelectCall[] = [];
  const shotUpdates: ShotUpdateCall[] = [];
  const callOrder: CallName[] = [];
  const scopedDb: PersistUpscaleScopedDb = {
    frameVariants: {
      update: async (versionId, data) => {
        variantUpdates.push({ versionId, data });
        callOrder.push('frameVariants.update');
        return { id: versionId };
      },
      select: async (frameId, versionId, optsArg) => {
        selects.push({ frameId, versionId, actorId: optsArg.actorId });
        callOrder.push('frameVariants.select');
        return { id: versionId };
      },
    },
    frames: {
      getAnchorByShot: async () => {
        callOrder.push('frames.getAnchorByShot');
        return opts.anchorMissing ? null : { id: 'anchor-frame-id' };
      },
    },
    shots: {
      update: async (shotId, data) => {
        shotUpdates.push({ shotId, data });
        callOrder.push('shots.update');
        return { id: shotId };
      },
    },
  };
  return {
    scopedDb,
    variantUpdates,
    selects,
    shotUpdates,
    callOrder,
  };
}

const NOW = new Date('2026-06-26T00:00:00Z');

describe('persistUpscaleSelection', () => {
  it('completes the version, repoints the frame at it, emits completed', async () => {
    const { scopedDb, variantUpdates, selects, shotUpdates, callOrder } =
      buildScopedDbSpy();
    const emits: Array<{
      shotId: string;
      status: string;
      thumbnailUrl: string;
    }> = [];

    const result = await persistUpscaleSelection({
      scopedDb,
      shotId: 'shot-1',
      versionId: 'ver-1',
      url: 'https://r2/upscaled.png',
      path: 'team/seq/upscaled.png',
      actorId: 'user-1',
      generatedAt: NOW,
      emit: async (payload) => {
        emits.push(payload);
      },
    });

    expect(result).toEqual({ selected: true });

    // Version is completed BEFORE the anchor is resolved + repointed.
    expect(callOrder).toEqual([
      'frameVariants.update',
      'frames.getAnchorByShot',
      'frameVariants.select',
    ]);

    const [versionUpdate] = variantUpdates;
    if (!versionUpdate) throw new Error('expected frameVariants.update call');
    expect(versionUpdate.versionId).toBe('ver-1');
    expect(versionUpdate.data).toEqual({
      status: 'completed',
      url: 'https://r2/upscaled.png',
      storagePath: 'team/seq/upscaled.png',
      generatedAt: NOW,
      error: null,
    });

    // Repoint targets the ANCHOR frame's id (≠ shotId), not the shot id.
    const [select] = selects;
    if (!select) throw new Error('expected frameVariants.select call');
    expect(select.frameId).toBe('anchor-frame-id');
    expect(select.versionId).toBe('ver-1');
    expect(select.actorId).toBe('user-1');

    // The existing render survives a new still (#1067 phase 2d) — no selection
    // is dropped and nothing is written to the shot.
    expect(shotUpdates).toEqual([]);

    expect(emits).toEqual([
      {
        shotId: 'shot-1',
        status: 'completed',
        thumbnailUrl: 'https://r2/upscaled.png',
      },
    ]);
  });

  it('still completes the version but skips the repoint when the anchor frame vanished', async () => {
    const { scopedDb, variantUpdates, selects, shotUpdates, callOrder } =
      buildScopedDbSpy({ anchorMissing: true });
    const emits: Array<{
      shotId: string;
      status: string;
      thumbnailUrl: string;
    }> = [];

    const result = await persistUpscaleSelection({
      scopedDb,
      shotId: 'shot-1',
      versionId: 'ver-1',
      url: 'https://r2/upscaled.png',
      path: null,
      actorId: 'user-1',
      generatedAt: NOW,
      emit: async (payload) => {
        emits.push(payload);
      },
    });

    expect(result).toEqual({ selected: false });
    // The version is finished, but with no anchor there is nothing to repoint:
    // no select, no completed emit (a false "ready" signal).
    expect(callOrder).toEqual([
      'frameVariants.update',
      'frames.getAnchorByShot',
    ]);
    expect(variantUpdates).toHaveLength(1);
    expect(selects).toEqual([]);
    expect(shotUpdates).toEqual([]);
    expect(emits).toEqual([]);
  });
});
