/**
 * Scoped Talent Sub-module
 * Team-scoped talent library CRUD with sheet counts and default sheets.
 */

import type { Database } from '@/lib/db/client';
import type {
  NewTalent,
  NewTalentMedia,
  NewTalentSheet,
  Talent,
  TalentMediaRecord,
  TalentSheet,
  TalentWithSheets,
} from '@/lib/db/schema';
import { talent, talentMedia, talentSheets } from '@/lib/db/schema';
import {
  SERVER_MANAGED_TALENT_COLUMNS,
  type ServerManagedTalentColumn,
} from '@/lib/schemas/talent.schemas';
import { and, asc, desc, eq, or, sql } from 'drizzle-orm';
import { stripServerManagedColumns } from './server-managed';

const TALENT_WRITE_DENIED =
  'Talent not found or you do not have permission to modify it';

/**
 * Write-side ACL for scoped talent mutations. Public/system templates are
 * readable by every team but writable only by non-public, team-owned rows.
 */
export function isTeamWritableTalent(
  record: { teamId: string; isPublic: boolean | null },
  teamId: string
): boolean {
  return record.teamId === teamId && !record.isPublic;
}

async function getWritableTalent(
  db: Database,
  talentId: string,
  teamId: string
): Promise<Talent | undefined> {
  const record = await db.query.talent.findFirst({
    where: { id: talentId },
  });
  if (!record || !isTeamWritableTalent(record, teamId)) {
    return undefined;
  }
  return record;
}

async function requireWritableTalent(
  db: Database,
  talentId: string,
  teamId: string
): Promise<Talent> {
  const record = await getWritableTalent(db, talentId, teamId);
  if (!record) {
    throw new Error(TALENT_WRITE_DENIED);
  }
  return record;
}

/** Resolve a sheet to its parent talent and enforce the write ACL. */
export async function assertTalentSheetWritableForTeam(
  db: Database,
  talentSheetId: string,
  teamId: string
): Promise<void> {
  const sheet = await db.query.talentSheets.findFirst({
    where: { id: talentSheetId },
  });
  if (!sheet) {
    throw new Error(`TalentSheet ${talentSheetId} not found`);
  }
  await requireWritableTalent(db, sheet.talentId, teamId);
}

/**
 * Shared implementation for team-scoped and public (anonymous) talent reads.
 * A null teamId means public-only scope: every query filters on isPublic with
 * no team arm, so the anonymous code path cannot express a team-scoped query.
 */
function createTalentReadMethodsScoped(db: Database, teamId: string | null) {
  const scope =
    teamId === null
      ? eq(talent.isPublic, true)
      : or(eq(talent.teamId, teamId), eq(talent.isPublic, true));
  const queryScope =
    teamId === null
      ? { isPublic: true }
      : { OR: [{ teamId }, { isPublic: true }] };

  return {
    list: async (options?: {
      favoritesOnly?: boolean;
    }): Promise<TalentWithSheets[]> => {
      const conditions = [scope];
      if (options?.favoritesOnly) {
        conditions.push(eq(talent.isFavorite, true));
      }

      const results = await db
        .select({
          talent: talent,
          sheetCount: sql<number>`(
            SELECT COUNT(*) FROM talent_sheets
            WHERE talent_sheets.talent_id = ${sql.raw(`"talent"."id"`)}
          )`
            .mapWith(Number)
            .as('sheet_count'),
        })
        .from(talent)
        .where(and(...conditions))
        .orderBy(desc(talent.isFavorite), asc(talent.name));

      const talentIds = results.map((r) => r.talent.id);
      if (talentIds.length === 0) return [];

      const defaultSheets = await db
        .select()
        .from(talentSheets)
        .where(
          and(
            sql`${talentSheets.talentId} IN (${sql.join(
              talentIds.map((id) => sql`${id}`),
              sql`, `
            )})`,
            eq(talentSheets.isDefault, true)
          )
        );

      const sheetMap = new Map<string, TalentSheet>(
        defaultSheets.map((s) => [s.talentId, s])
      );

      const talentWithoutDefault = talentIds.filter((id) => !sheetMap.has(id));
      if (talentWithoutDefault.length > 0) {
        // Exclude divergent sheets from the "any sheet" fallback so a
        // divergent first-time-generation row cannot leak into the
        // talent's displayed identity. Convergent rows are returned in
        // recency order; the most recent wins.
        const fallbackSheets = await db
          .select()
          .from(talentSheets)
          .where(
            and(
              sql`${talentSheets.talentId} IN (${sql.join(
                talentWithoutDefault.map((id) => sql`${id}`),
                sql`, `
              )})`,
              sql`${talentSheets.divergedAt} IS NULL`
            )
          )
          .orderBy(desc(talentSheets.createdAt));

        for (const sheet of fallbackSheets) {
          if (!sheetMap.has(sheet.talentId)) {
            sheetMap.set(sheet.talentId, sheet);
          }
        }
      }

      return results.map((r) => ({
        ...r.talent,
        sheetCount: r.sheetCount,
        sheets: [],
        defaultSheet: sheetMap.get(r.talent.id) ?? null,
      }));
    },

    getByIds: async (ids: string[]): Promise<TalentWithSheets[]> => {
      if (ids.length === 0) return [];

      const results = await db
        .select({
          talent: talent,
          sheetCount: sql<number>`(
            SELECT COUNT(*) FROM talent_sheets
            WHERE talent_sheets.talent_id = ${sql.raw(`"talent"."id"`)}
          )`
            .mapWith(Number)
            .as('sheet_count'),
        })
        .from(talent)
        .where(
          and(
            scope,
            sql`${talent.id} IN (${sql.join(
              ids.map((id) => sql`${id}`),
              sql`, `
            )})`
          )
        );

      if (results.length === 0) return [];

      const fetchedIds = results.map((r) => r.talent.id);
      const defaultSheets = await db
        .select()
        .from(talentSheets)
        .where(
          and(
            sql`${talentSheets.talentId} IN (${sql.join(
              fetchedIds.map((id) => sql`${id}`),
              sql`, `
            )})`,
            eq(talentSheets.isDefault, true)
          )
        );

      const sheetMap = new Map<string, TalentSheet>(
        defaultSheets.map((s) => [s.talentId, s])
      );

      const talentWithoutDefault = fetchedIds.filter((id) => !sheetMap.has(id));
      if (talentWithoutDefault.length > 0) {
        // Exclude divergent sheets from the "any sheet" fallback so a
        // divergent first-time-generation row cannot be cast as the talent's
        // identity by downstream consumers (e.g. talent-matching workflow,
        // which reads `defaultSheet?.imageUrl` for the LLM matching prompt).
        const fallbackSheets = await db
          .select()
          .from(talentSheets)
          .where(
            and(
              sql`${talentSheets.talentId} IN (${sql.join(
                talentWithoutDefault.map((id) => sql`${id}`),
                sql`, `
              )})`,
              sql`${talentSheets.divergedAt} IS NULL`
            )
          )
          .orderBy(desc(talentSheets.createdAt));

        for (const sheet of fallbackSheets) {
          if (!sheetMap.has(sheet.talentId)) {
            sheetMap.set(sheet.talentId, sheet);
          }
        }
      }

      return results.map((r) => ({
        ...r.talent,
        sheetCount: r.sheetCount,
        sheets: [],
        defaultSheet: sheetMap.get(r.talent.id) ?? null,
      }));
    },

    getById: async (talentId: string): Promise<Talent | undefined> => {
      return db.query.talent.findFirst({
        where: { id: talentId, ...queryScope },
      });
    },

    getWithRelations: async (talentId: string) => {
      return db.query.talent.findFirst({
        where: { id: talentId, ...queryScope },
        with: {
          sheets: {
            orderBy: { isDefault: 'desc', createdAt: 'desc' },
          },
          media: {
            orderBy: { createdAt: 'desc' },
          },
        },
      });
    },

    sheets: {
      getById: async (sheetId: string): Promise<TalentSheet | undefined> => {
        return db.query.talentSheets.findFirst({
          where: { id: sheetId },
        });
      },

      isStale: async (
        sheetId: string,
        currentHash: string
      ): Promise<boolean> => {
        const result = await db
          .select({ hash: talentSheets.inputHash })
          .from(talentSheets)
          .where(eq(talentSheets.id, sheetId));
        const first = result[0];
        if (!first) {
          throw new Error(`TalentSheet ${sheetId} not found`);
        }
        const stored = first.hash;
        if (stored === null) return false;
        return currentHash !== stored;
      },
    },

    media: {
      getById: async (
        mediaId: string
      ): Promise<TalentMediaRecord | undefined> => {
        return db.query.talentMedia.findFirst({
          where: { id: mediaId },
        });
      },
    },
  };
}

function createTalentReadMethods(db: Database, teamId: string) {
  return createTalentReadMethodsScoped(db, teamId);
}

/**
 * Public (anonymous) talent reads — list and detail only, public-only scope.
 * The entire data boundary for the unauthenticated talent endpoints.
 */
export function createPublicTalentReadMethods(db: Database) {
  const { list, getWithRelations } = createTalentReadMethodsScoped(db, null);
  return { list, getWithRelations };
}

export function createTalentMethods(
  db: Database,
  teamId: string,
  userId: string
) {
  const read = createTalentReadMethods(db, teamId);

  return {
    ...read,

    // Server-managed columns (isPublic, isTemplate, …) are excluded from the
    // parameter type AND scrubbed at runtime: the type alone doesn't stop a
    // non-literal object from carrying extra keys, and drizzle writes any key
    // that matches a table column. Admin paths (the system template seeder)
    // insert via raw drizzle instead.
    create: async (
      data: Omit<NewTalent, ServerManagedTalentColumn>
    ): Promise<Talent> => {
      const [created] = await db
        .insert(talent)
        .values({
          ...stripServerManagedColumns(data, SERVER_MANAGED_TALENT_COLUMNS),
          teamId,
          createdBy: userId,
        })
        .returning();
      if (!created) throw new Error('Failed to create talent');
      return created;
    },

    update: async (
      talentId: string,
      data: Partial<Omit<Talent, ServerManagedTalentColumn>>
    ): Promise<Talent | undefined> => {
      if (!(await getWritableTalent(db, talentId, teamId))) {
        return undefined;
      }

      const [updated] = await db
        .update(talent)
        .set({
          ...stripServerManagedColumns(data, SERVER_MANAGED_TALENT_COLUMNS),
          updatedAt: new Date(),
        })
        .where(and(eq(talent.id, talentId), eq(talent.teamId, teamId)))
        .returning();
      return updated;
    },

    delete: async (talentId: string): Promise<boolean> => {
      if (!(await getWritableTalent(db, talentId, teamId))) {
        return false;
      }

      const result = await db
        .delete(talent)
        .where(and(eq(talent.id, talentId), eq(talent.teamId, teamId)));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return (result.rowsAffected ?? 0) > 0;
    },

    toggleFavorite: async (talentId: string): Promise<Talent | undefined> => {
      const existing = await getWritableTalent(db, talentId, teamId);
      if (!existing) return undefined;

      const [updated] = await db
        .update(talent)
        .set({ isFavorite: !existing.isFavorite, updatedAt: new Date() })
        .where(and(eq(talent.id, talentId), eq(talent.teamId, teamId)))
        .returning();
      return updated;
    },

    sheets: {
      ...read.sheets,

      create: async (data: NewTalentSheet): Promise<TalentSheet> => {
        await requireWritableTalent(db, data.talentId, teamId);

        const existingSheets = await db
          .select({ count: sql<number>`count(*)`.mapWith(Number) })
          .from(talentSheets)
          .where(eq(talentSheets.talentId, data.talentId));

        const sheetCount = existingSheets[0]?.count ?? 0;
        // Honor an explicit `isDefault` (including `false`) so callers writing
        // a known non-default row — e.g. the divergence path in
        // `library-talent-sheet-workflow` — don't get auto-promoted to default
        // just because the talent has no sheets yet. Only fall back to the
        // first-sheet auto-promote when isDefault is undefined.
        const shouldBeDefault = data.isDefault ?? sheetCount === 0;

        if (shouldBeDefault && sheetCount > 0) {
          await db
            .update(talentSheets)
            .set({ isDefault: false })
            .where(eq(talentSheets.talentId, data.talentId));
        }

        const [sheet] = await db
          .insert(talentSheets)
          .values({ ...data, isDefault: shouldBeDefault })
          .returning();
        if (!sheet) throw new Error('Failed to create talent sheet');
        return sheet;
      },

      update: async (
        sheetId: string,
        data: Partial<Omit<TalentSheet, 'id' | 'talentId' | 'createdAt'>>
      ): Promise<TalentSheet | undefined> => {
        const sheetForAcl = await db.query.talentSheets.findFirst({
          where: { id: sheetId },
        });
        if (
          !sheetForAcl ||
          !(await getWritableTalent(db, sheetForAcl.talentId, teamId))
        ) {
          return undefined;
        }

        if (data.isDefault) {
          await db
            .update(talentSheets)
            .set({ isDefault: false })
            .where(eq(talentSheets.talentId, sheetForAcl.talentId));
        }

        const [updated] = await db
          .update(talentSheets)
          .set({ ...data, updatedAt: new Date() })
          .where(eq(talentSheets.id, sheetId))
          .returning();

        return updated;
      },

      delete: async (sheetId: string): Promise<boolean> => {
        const sheet = await db.query.talentSheets.findFirst({
          where: { id: sheetId },
        });
        if (!sheet || !(await getWritableTalent(db, sheet.talentId, teamId))) {
          return false;
        }

        const result = await db
          .delete(talentSheets)
          .where(eq(talentSheets.id, sheetId));

        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
        if ((result.rowsAffected ?? 0) === 0) return false;

        if (sheet.isDefault) {
          const remaining = await db
            .select()
            .from(talentSheets)
            .where(eq(talentSheets.talentId, sheet.talentId));

          const onlyRemaining = remaining[0];
          if (remaining.length === 1 && onlyRemaining) {
            await db
              .update(talentSheets)
              .set({ isDefault: true, updatedAt: new Date() })
              .where(eq(talentSheets.id, onlyRemaining.id));
          }
        }

        return true;
      },
    },

    media: {
      ...read.media,

      create: async (data: NewTalentMedia): Promise<TalentMediaRecord> => {
        await requireWritableTalent(db, data.talentId, teamId);

        const [media] = await db.insert(talentMedia).values(data).returning();
        if (!media) throw new Error('Failed to create talent media');
        return media;
      },

      delete: async (mediaId: string): Promise<boolean> => {
        const media = await db.query.talentMedia.findFirst({
          where: { id: mediaId },
        });
        if (!media || !(await getWritableTalent(db, media.talentId, teamId))) {
          return false;
        }

        const result = await db
          .delete(talentMedia)
          .where(eq(talentMedia.id, mediaId));
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
        return (result.rowsAffected ?? 0) > 0;
      },
    },
  };
}
