/**
 * Scoped Scenes Sub-module
 * Scene CRUD and ordered listing within a sequence.
 *
 * Scenes are the narrative units introduced in #907. Each owns an ordered list
 * of shots; this stage keeps every sequence as scenes-of-one-shot.
 */

import type { Database } from '@/lib/db/client';
import { scenes } from '@/lib/db/schema';
import type { DbSceneId, NewScene, SceneRow } from '@/lib/db/schema';
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';

type SceneOrderBy = 'orderIndex' | 'createdAt' | 'updatedAt';

type SceneFilters = {
  orderBy?: SceneOrderBy;
  ascending?: boolean;
};

export function createScenesMethods(db: Database) {
  return {
    getById: async (sceneId: DbSceneId): Promise<SceneRow | null> => {
      const result = await db
        .select()
        .from(scenes)
        .where(eq(scenes.id, sceneId));
      return result[0] ?? null;
    },

    listBySequence: async (
      sequenceId: string,
      options?: SceneFilters
    ): Promise<SceneRow[]> => {
      const { orderBy = 'orderIndex', ascending = true } = options ?? {};

      const orderColumn =
        orderBy === 'orderIndex'
          ? scenes.orderIndex
          : orderBy === 'createdAt'
            ? scenes.createdAt
            : scenes.updatedAt;

      const orderFn = ascending ? asc : desc;

      return await db
        .select()
        .from(scenes)
        .where(eq(scenes.sequenceId, sequenceId))
        .orderBy(orderFn(orderColumn));
    },

    create: async (data: NewScene): Promise<SceneRow> => {
      const [scene] = await db.insert(scenes).values(data).returning();
      if (!scene) {
        throw new Error(
          `Failed to create scene for sequence ${data.sequenceId}`
        );
      }
      return scene;
    },

    /**
     * Idempotent write keyed on `(sequenceId, orderIndex)` — the table's
     * unique index. Streaming scene-split calls this as each analysis scene
     * lands so the editor spine can group shots under scene headers mid-run
     * (1:1 today; multi-shot later). A replay of the same orderIndex updates
     * narrative fields in place and keeps the same row id, so in-flight shot
     * links stay valid.
     */
    upsert: async (data: NewScene): Promise<SceneRow> => {
      const [scene] = await db
        .insert(scenes)
        .values(data)
        .onConflictDoUpdate({
          target: [scenes.sequenceId, scenes.orderIndex],
          set: {
            location: sql.raw(`excluded."location"`),
            timeOfDay: sql.raw(`excluded."time_of_day"`),
            storyBeat: sql.raw(`excluded."story_beat"`),
            title: sql.raw(`excluded."title"`),
            continuity: sql.raw(`excluded."continuity"`),
            musicDesign: sql.raw(`excluded."music_design"`),
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!scene) {
        throw new Error(
          `Failed to upsert scene for sequence ${data.sequenceId} at orderIndex ${data.orderIndex}`
        );
      }
      return scene;
    },

    update: async (
      sceneId: DbSceneId,
      data: Partial<NewScene>,
      options?: { throwOnMissing?: boolean }
    ): Promise<SceneRow | undefined> => {
      const [scene] = await db
        .update(scenes)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(scenes.id, sceneId))
        .returning();

      if (!scene && options?.throwOnMissing !== false) {
        throw new Error(`Scene ${sceneId} not found`);
      }

      return scene;
    },

    delete: async (sceneId: DbSceneId): Promise<boolean> => {
      const result = await db.delete(scenes).where(eq(scenes.id, sceneId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return (result.rowsAffected ?? 0) > 0;
    },

    deleteBySequence: async (sequenceId: string): Promise<number> => {
      const result = await db
        .delete(scenes)
        .where(eq(scenes.sequenceId, sequenceId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return result.rowsAffected ?? 0;
    },

    /**
     * Drop scenes at `orderIndex >= minOrderIndex` for a sequence. Used after
     * an upsert-based rewrite when a re-analyze produced fewer scenes than
     * before — the stream/reconcile path keeps stable row ids for the kept
     * indexes, so we only remove the tail.
     *
     * Callers must ensure no `shots.scene_id` still points at those rows:
     * the migration-added FK is bare `REFERENCES scenes(id)` (no ON DELETE
     * SET NULL), so a delete with live shot links fails (#1072).
     */
    deleteFromOrderIndex: async (
      sequenceId: string,
      minOrderIndex: number
    ): Promise<number> => {
      const result = await db
        .delete(scenes)
        .where(
          and(
            eq(scenes.sequenceId, sequenceId),
            gte(scenes.orderIndex, minOrderIndex)
          )
        );
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return result.rowsAffected ?? 0;
    },

    createBulk: async (sceneData: NewScene[]): Promise<SceneRow[]> => {
      if (sceneData.length === 0) return [];

      const BATCH_SIZE = 5;
      const results: SceneRow[] = [];

      for (let i = 0; i < sceneData.length; i += BATCH_SIZE) {
        const batch = sceneData.slice(i, i + BATCH_SIZE);
        const batchResults = await db.insert(scenes).values(batch).returning();
        results.push(...batchResults);
      }

      // Fail loud on a short write rather than silently returning fewer rows
      // than requested. (Batches are not atomic across the loop — same as
      // shots.createBulk — so a mid-loop throw can leave earlier batches
      // committed; the count check at least surfaces a truncated success.)
      if (results.length !== sceneData.length) {
        throw new Error(
          `createBulk inserted ${results.length}/${sceneData.length} scenes`
        );
      }

      return results;
    },

    getByIds: async (sceneIds: DbSceneId[]): Promise<SceneRow[]> => {
      if (sceneIds.length === 0) return [];
      return await db.select().from(scenes).where(inArray(scenes.id, sceneIds));
    },
  };
}
