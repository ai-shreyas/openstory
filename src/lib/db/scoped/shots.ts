/**
 * Scoped Shots Sub-module
 * Shot CRUD, bulk operations, reorder, and reconciliation.
 */

import type { Database } from '@/lib/db/client';
import { frames, shots } from '@/lib/db/schema';
import type { NewFrame, Shot, NewShot, VideoVariant } from '@/lib/db/schema';
import type { Sequence } from '@/lib/db/schema/sequences';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

/**
 * A `video_variants` version that has finished generating AND has its output
 * URL/path — the ONLY kind that may become a shot's primary video. Mirroring a
 * pending/failed (or a `completed`-but-url-less) version would copy a null url
 * onto the shot, silently blanking a good video. The intersection encodes BOTH
 * halves of the precondition (`status` *and* url/path non-null) so
 * {@link buildShotVideoMirror}'s `videoUrl`/`videoPath` writes are provably
 * non-null at compile time (mirrors `CompletedFrameVariant`). The narrowing site
 * (`videoVariants.select`) asserts the url/path, so this type is never forged.
 */
export type CompletedVideoVariant = VideoVariant & {
  status: 'completed';
  url: string;
  storagePath: string;
};

/**
 * Build (without executing) the UPDATE that mirrors a selected video version's
 * output onto its shot for playback, so a caller can compose it into the same
 * `db.batch()` as the segment selection repoint and the activity event. The
 * selection pointer itself lives on `render_segments.selectedVideoVersionId`
 * (#990); the shot's `video*` columns are the cached playback mirror. Returns
 * the drizzle statement; the caller owns execution.
 *
 * `durationMs` is the manifest's summed duration (a multi-shot segment's video
 * spans all its shots); the per-shot value carried on the shot is informational.
 */
export function buildShotVideoMirror(
  db: Database,
  shotId: string,
  version: CompletedVideoVariant
) {
  const durationMs = version.manifest.reduce(
    (sum, entry) => sum + entry.durationMs,
    0
  );
  return db
    .update(shots)
    .set({
      videoUrl: version.url,
      videoPath: version.storagePath,
      videoStatus: version.status,
      videoGeneratedAt: version.generatedAt,
      videoError: version.error,
      motionModel: version.model,
      videoInputHash: version.inputHash,
      ...(durationMs > 0 ? { durationMs } : {}),
      updatedAt: new Date(),
    })
    .where(eq(shots.id, shotId));
}

/**
 * Every shot owns an anchor frame (orderIndex 0, role 'first') — the i2v anchor
 * and the shot's primary still. Since the image surface lives on `frames` (#989),
 * shot creation must materialize that frame or the image path has nowhere to
 * write. The frame gets its OWN generated id (NOT the shot's) — id-reuse was a
 * one-time migration shortcut and is never assumed at runtime; the anchor is
 * resolved by `(shotId, orderIndex 0)` via `frames.getAnchorByShot`. `imageModel`
 * / `imageStatus` keep their schema defaults here; the image workflow stamps the
 * real values when generation runs.
 */
function anchorFrameValues(shot: Pick<Shot, 'id' | 'sequenceId'>): NewFrame {
  return {
    // No explicit id: the schema's $defaultFn mints a fresh ULID. Replays dedupe
    // on the (shotId, orderIndex) unique index via onConflictDoNothing below.
    shotId: shot.id,
    sequenceId: shot.sequenceId,
    orderIndex: 0,
    role: 'first',
  };
}

type ShotWithSequence = Shot & {
  sequence: Pick<
    Sequence,
    | 'id'
    | 'teamId'
    | 'title'
    | 'status'
    | 'styleId'
    | 'imageModel'
    | 'videoModel'
    | 'aspectRatio'
    | 'analysisModel'
  >;
};

type ShotOrderBy = 'orderIndex' | 'createdAt' | 'updatedAt';

/**
 * A persisted shot plus the id of its anchor frame (orderIndex 0), captured at
 * write time. Threaded into prompt workflows so they never read the anchor back
 * (#991: no DB reads in workflows). It is a superset of `Shot`, so callers that
 * only need the shot fields are unaffected.
 */
export type ShotWithAnchorFrame = Shot & { anchorFrameId: string };

// Image artifacts (thumbnail/variantImage) moved to `frames` in #989 — their
// staleness is checked via `frameVariants.isStale` / `frames.isStale`. Only the
// shot-owned video artifact remains here.
const SHOT_ARTIFACT_HASH_COLUMNS = {
  video: 'videoInputHash',
} as const satisfies Record<string, keyof Shot>;

// Anchor-frame inserts bind ~10 params per row; 9 rows/chunk keeps each INSERT
// well under D1's 100-bound-parameter ceiling (see `ensureAnchorFrames`).
const ANCHOR_FRAMES_BATCH = 9;

export type ShotHashArtifact = keyof typeof SHOT_ARTIFACT_HASH_COLUMNS;

type ShotFilters = {
  orderBy?: ShotOrderBy;
  ascending?: boolean;
  limit?: number;
  offset?: number;
  hasVideo?: boolean;
};

export function createShotsMethods(db: Database) {
  // Idempotently materialize the anchor frame for each created/upserted shot and
  // return each shot's anchor frame id keyed by shotId. A no-op `onConflictDoUpdate`
  // (re-setting `orderIndex` to its own value) keeps an existing frame — and its
  // image — intact on replay while still emitting the row via `RETURNING`, which a
  // plain `onConflictDoNothing` omits for the conflicting (pre-existing) rows. This
  // lets callers capture the anchor id at write time and thread it downstream
  // instead of reading it back (#991: no DB reads in workflows).
  //
  // Chunked to stay under D1's 100-bound-parameter ceiling: each anchor row binds
  // ~10 params (id, shotId, sequenceId, orderIndex, role, imageStatus,
  // createdAt, updatedAt — the schema defaults are inlined as binds),
  // so a single INSERT of a whole sequence's shots overflowed the limit and threw
  // (#1019: getShotsFn calls this with every shot on each read, so sequences with
  // more than ~10 shots stopped listing their scenes entirely).
  const ensureAnchorFrames = async (
    rows: ReadonlyArray<Pick<Shot, 'id' | 'sequenceId'>>
  ): Promise<Map<string, string>> => {
    if (rows.length === 0) return new Map();
    const result = new Map<string, string>();
    for (let i = 0; i < rows.length; i += ANCHOR_FRAMES_BATCH) {
      const batch = rows.slice(i, i + ANCHOR_FRAMES_BATCH);
      const anchors = await db
        .insert(frames)
        .values(batch.map(anchorFrameValues))
        .onConflictDoUpdate({
          target: [frames.shotId, frames.orderIndex],
          set: { orderIndex: sql.raw(`excluded."order_index"`) },
        })
        .returning({ id: frames.id, shotId: frames.shotId });
      for (const a of anchors) result.set(a.shotId, a.id);
    }
    return result;
  };

  return {
    ensureAnchorFrames,

    getById: async (shotId: string): Promise<Shot | null> => {
      const result = await db.select().from(shots).where(eq(shots.id, shotId));
      return result[0] ?? null;
    },

    listBySequence: async (
      sequenceId: string,
      options?: ShotFilters
    ): Promise<Shot[]> => {
      const {
        orderBy = 'orderIndex',
        ascending = true,
        limit,
        offset,
        hasVideo,
      } = options ?? {};

      const conditions = [eq(shots.sequenceId, sequenceId)];

      if (hasVideo !== undefined && hasVideo) {
        conditions.push(sql`${shots.videoUrl} IS NULL`);
      }

      const orderColumn =
        orderBy === 'orderIndex'
          ? shots.orderIndex
          : orderBy === 'createdAt'
            ? shots.createdAt
            : shots.updatedAt;

      const orderFn = ascending ? asc : desc;

      let query = db
        .select()
        .from(shots)
        .where(and(...conditions))
        .orderBy(orderFn(orderColumn))
        .$dynamic();

      if (limit) {
        query = query.limit(limit);
      }

      if (offset) {
        query = query.offset(offset);
      }

      return await query;
    },

    create: async (data: NewShot): Promise<Shot> => {
      const [shot] = await db.insert(shots).values(data).returning();
      if (!shot) {
        throw new Error(
          `Failed to create shot for sequence ${data.sequenceId}`
        );
      }
      await ensureAnchorFrames([shot]);
      return shot;
    },

    update: async (
      shotId: string,
      data: Partial<NewShot>,
      options?: { throwOnMissing?: boolean }
    ): Promise<Shot | undefined> => {
      const [shot] = await db
        .update(shots)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(shots.id, shotId))
        .returning();

      if (!shot && options?.throwOnMissing !== false) {
        throw new Error(`Shot ${shotId} not found`);
      }

      return shot;
    },
    upsert: async (data: NewShot): Promise<ShotWithAnchorFrame> => {
      const [shot] = await db
        .insert(shots)
        .values(data)
        .onConflictDoUpdate({
          target: [shots.sequenceId, shots.orderIndex],
          set: {
            description: sql.raw(`excluded."description"`),
            durationMs: sql.raw(`excluded."duration_ms"`),
            metadata: sql.raw(`excluded."metadata"`),
            // #908: a replay re-derives the same shot at the same orderIndex —
            // carry the scene link + intra-scene number through the conflict so
            // a re-run is idempotent rather than leaving stale values.
            sceneId: sql.raw(`excluded."scene_id"`),
            shotNumber: sql.raw(`excluded."shot_number"`),
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!shot) {
        throw new Error(
          `Failed to upsert shot for sequence ${data.sequenceId} at orderIndex ${data.orderIndex}`
        );
      }
      const anchorFrameId = (await ensureAnchorFrames([shot])).get(shot.id);
      if (!anchorFrameId) {
        throw new Error(
          `Failed to materialize anchor frame for shot ${shot.id}`
        );
      }
      return { ...shot, anchorFrameId };
    },
    delete: async (shotId: string): Promise<boolean> => {
      const result = await db.delete(shots).where(eq(shots.id, shotId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return (result.rowsAffected ?? 0) > 0;
    },

    deleteBySequence: async (sequenceId: string): Promise<number> => {
      const result = await db
        .delete(shots)
        .where(eq(shots.sequenceId, sequenceId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return result.rowsAffected ?? 0;
    },

    createBulk: async (shotData: NewShot[]): Promise<Shot[]> => {
      const BATCH_SIZE = 5;
      const results: Shot[] = [];

      for (let i = 0; i < shotData.length; i += BATCH_SIZE) {
        const batch = shotData.slice(i, i + BATCH_SIZE);
        const batchResults = await db.insert(shots).values(batch).returning();
        await ensureAnchorFrames(batchResults);
        results.push(...batchResults);
      }

      return results;
    },

    bulkUpsert: async (
      shotInserts: NewShot[]
    ): Promise<ShotWithAnchorFrame[]> => {
      const BATCH_SIZE = 5;
      const results: ShotWithAnchorFrame[] = [];

      for (let i = 0; i < shotInserts.length; i += BATCH_SIZE) {
        const batch = shotInserts.slice(i, i + BATCH_SIZE);
        const batchResults = await db
          .insert(shots)
          .values(batch)
          .onConflictDoUpdate({
            target: [shots.sequenceId, shots.orderIndex],
            set: {
              description: sql.raw(`excluded."description"`),
              durationMs: sql.raw(`excluded."duration_ms"`),
              metadata: sql.raw(`excluded."metadata"`),
              // #908: keep the scene link + intra-scene number idempotent on
              // replay (see the matching note in `upsert`).
              sceneId: sql.raw(`excluded."scene_id"`),
              shotNumber: sql.raw(`excluded."shot_number"`),
              updatedAt: new Date(),
            },
          })
          .returning();
        const anchors = await ensureAnchorFrames(batchResults);
        for (const shot of batchResults) {
          const anchorFrameId = anchors.get(shot.id);
          if (!anchorFrameId) {
            throw new Error(
              `Failed to materialize anchor frame for shot ${shot.id}`
            );
          }
          results.push({ ...shot, anchorFrameId });
        }
      }

      return results;
    },

    reorder: async (
      _sequenceId: string,
      shotOrders: Array<{ id: string; order_index: number }>
    ): Promise<void> => {
      if (shotOrders.length === 0) return;
      const [first, ...rest] = shotOrders.map((shotOrder) =>
        db
          .update(shots)
          .set({ orderIndex: shotOrder.order_index, updatedAt: new Date() })
          .where(eq(shots.id, shotOrder.id))
      );
      if (!first) return;
      await db.batch([first, ...rest]);
    },

    getByIds: async (shotIds: string[]): Promise<Shot[]> => {
      if (shotIds.length === 0) return [];
      return await db.select().from(shots).where(inArray(shots.id, shotIds));
    },

    /**
     * Compares the stored input hash for an artifact against a caller-provided
     * fresh hash. Returns false when the stored hash is null — legacy artifacts
     * predating hash tracking are treated as "unknown, not stale" rather than
     * forced into regeneration. Throws when the shot row does not exist.
     */
    isStale: async (
      shotId: string,
      artifact: ShotHashArtifact,
      currentHash: string
    ): Promise<boolean> => {
      const result = await db
        .select({
          hash: shots[SHOT_ARTIFACT_HASH_COLUMNS[artifact]],
        })
        .from(shots)
        .where(eq(shots.id, shotId));
      const row = result[0];
      if (!row) {
        throw new Error(`Shot ${shotId} not found`);
      }
      const stored = row.hash;
      if (stored === null) return false;
      return currentHash !== stored;
    },

    getWithSequence: async (
      shotId: string
    ): Promise<ShotWithSequence | null> => {
      const result = await db.query.shots.findFirst({
        where: { id: shotId },
        with: {
          sequence: {
            columns: {
              id: true,
              teamId: true,
              title: true,
              status: true,
              styleId: true,
              // Both model defaults: the shot-scoped generate paths resolve
              // image AND video models against the sequence tier (#1066).
              imageModel: true,
              videoModel: true,
              aspectRatio: true,
              analysisModel: true,
            },
          },
        },
      });

      if (!result || !result.sequence) return null;
      return { ...result, sequence: result.sequence };
    },
  };
}
