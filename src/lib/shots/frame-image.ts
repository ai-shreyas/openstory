/**
 * Reading a frame's still.
 *
 * Since #1067 the still is not a column on `frames` — it is whichever
 * `frame_variants` row `frames.selectedImageVersionId` points at. Nearly every
 * caller wants one field off that row (the URL, for i2v conditioning or a
 * motion-prompt hash), so these two helpers keep the pointer-follow in one
 * place instead of at ~10 call sites.
 *
 * Both return null for "no still yet" — no selection, a dangling pointer, or a
 * selection whose version was discarded. Callers that need the whole version
 * row (model, hashes, provenance) should use
 * `scopedDb.frameVariants.getSelected` / `getSelectedByFrameIds` directly.
 */

import type { ScopedDb } from '@/lib/db/scoped';

/** The selected still's URL for a frame, or null when it has none. */
export async function getFrameImageUrl(
  scopedDb: Pick<ScopedDb, 'frameVariants'>,
  frameId: string
): Promise<string | null> {
  const selected = await scopedDb.frameVariants.getSelected(frameId);
  return selected?.url ?? null;
}

/**
 * The selected still's URL for a shot's ANCHOR frame (orderIndex 0) — the i2v
 * anchor. Resolved by shotId, never by the migration-era `frame.id == shot.id`
 * equality. Null when the shot has no anchor frame or no selected still.
 */
export async function getAnchorImageUrl(
  scopedDb: Pick<ScopedDb, 'frames' | 'frameVariants'>,
  shotId: string
): Promise<string | null> {
  const anchor = await scopedDb.frames.getAnchorByShot(shotId);
  if (!anchor) return null;
  return await getFrameImageUrl(scopedDb, anchor.id);
}
