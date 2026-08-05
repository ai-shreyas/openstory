/**
 * Scoped Styles Sub-module
 * Team-scoped style library CRUD (includes public styles in listing).
 */

import type { Database } from '@/lib/db/client';
import type { NewStyle, Style } from '@/lib/db/schema';
import { styles } from '@/lib/db/schema';
import { ValidationError } from '@/lib/errors';
import {
  SERVER_MANAGED_STYLE_COLUMNS,
  type ServerManagedStyleColumn,
} from '@/lib/schemas/style.schemas';
import { stripServerManagedColumns } from './server-managed';
import { styleSlug } from '@/lib/style/style-slug';
import { and, asc, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'db', 'styles']);

// `listByIds` chunks its id list per query. It binds only id params (no team
// filter), so it could go to D1's 100-bound-parameter ceiling; we hold it at 90
// to match the sibling sequences.listShotsByIds batch size.
const STYLES_BY_IDS_BATCH = 90;

type StylesListOptions = {
  orderBy?: 'popular' | 'sortOrder';
};

/**
 * A style's URL/asset slug is derived from its name (`styleSlug`) and is the key
 * the `?style=<slug>` composer prefill (and every style asset path) resolves on.
 * A team only ever sees its own styles plus public ones, so the slug must be
 * unique within that union — otherwise a slug would be ambiguous for that
 * account. Enforced here (no DB constraint can express "unique across this team
 * ∪ all public") on create + rename. `excludeId` skips the row being renamed.
 *
 * This guards against the future where teams can author styles; public styles
 * are seeded with already-unique names.
 */
async function assertSlugAvailable(
  db: Database,
  teamId: string,
  name: string,
  excludeId?: string
): Promise<void> {
  const slug = styleSlug(name);
  const visible = await db
    .select({ id: styles.id, name: styles.name })
    .from(styles)
    .where(
      and(
        or(eq(styles.teamId, teamId), eq(styles.isPublic, true)),
        excludeId ? ne(styles.id, excludeId) : undefined
      )
    );
  const clash = visible.find((s) => styleSlug(s.name) === slug);
  if (clash) {
    throw new ValidationError(
      `A style named “${clash.name}” already exists, which would share the URL slug “${slug}”. Choose a more distinct name.`,
      { slug, conflictsWith: clash.name }
    );
  }
}

function createStylesReadMethods(db: Database, teamId: string) {
  return {
    list: async (options: StylesListOptions = {}): Promise<Style[]> => {
      const orderBy = options.orderBy ?? 'sortOrder';
      const order =
        orderBy === 'popular'
          ? [desc(styles.usageCount), asc(styles.name)]
          : [asc(styles.sortOrder), asc(styles.name)];
      return await db
        .select()
        .from(styles)
        .where(or(eq(styles.teamId, teamId), eq(styles.isPublic, true)))
        .orderBy(...order);
    },

    getById: async (styleId: string): Promise<Style | null> => {
      const result = await db
        .select()
        .from(styles)
        .where(eq(styles.id, styleId))
        .limit(1);
      return result[0] ?? null;
    },

    /**
     * Batched style fetch by id — resolves the style rows referenced by a page
     * of sequences in one batched fetch (one query per ≤90-id chunk), backing
     * the `style` block in the public `GET /api/v1/sequences` list. Like
     * `getById`, it resolves by id alone (no team scope): the ids come from the
     * team's own sequences, which reference their team's styles plus public
     * ones. Duplicate ids collapse and order is not guaranteed — callers index
     * the result by id, and an id that resolves to no row simply has no entry.
     */
    listByIds: async (styleIds: string[]): Promise<Style[]> => {
      if (styleIds.length === 0) return [];
      const unique = [...new Set(styleIds)];
      const batches: string[][] = [];
      for (let i = 0; i < unique.length; i += STYLES_BY_IDS_BATCH) {
        batches.push(unique.slice(i, i + STYLES_BY_IDS_BATCH));
      }
      const results = await Promise.all(
        batches.map((batch) =>
          db.select().from(styles).where(inArray(styles.id, batch))
        )
      );
      return results.flat();
    },
  };
}

/**
 * Public (anonymous) styles reads. Takes no team scope at all, so this code
 * path cannot express a team-scoped query — the isPublic filter is the entire
 * data boundary for the unauthenticated style-catalogue endpoint.
 */
export function createPublicStylesReadMethods(db: Database) {
  return {
    list: async (): Promise<Style[]> => {
      return await db
        .select()
        .from(styles)
        .where(eq(styles.isPublic, true))
        .orderBy(asc(styles.sortOrder), asc(styles.name));
    },
  };
}

export function createStylesMethods(
  db: Database,
  teamId: string,
  userId: string
) {
  return {
    ...createStylesReadMethods(db, teamId),

    // Server-managed columns (isPublic, isTemplate, usageCount, …) are
    // excluded from the parameter type AND scrubbed at runtime: the type
    // alone doesn't stop a non-literal object from carrying extra keys, and
    // drizzle writes any key that matches a table column. Admin paths (the
    // system template seeder) insert via raw drizzle instead.
    create: async (
      data: Omit<NewStyle, ServerManagedStyleColumn>
    ): Promise<Style> => {
      await assertSlugAvailable(db, teamId, data.name);
      const result = await db
        .insert(styles)
        .values({
          ...stripServerManagedColumns(data, SERVER_MANAGED_STYLE_COLUMNS),
          teamId,
          createdBy: userId,
        })
        .returning();
      const style = result[0];
      if (!style) {
        throw new Error(`Failed to create Style for team ${teamId}`);
      }
      return style;
    },

    update: async (
      styleId: string,
      data: Partial<Omit<Style, ServerManagedStyleColumn>>
    ): Promise<Style | undefined> => {
      if (data.name !== undefined) {
        await assertSlugAvailable(db, teamId, data.name, styleId);
      }
      const result = await db
        .update(styles)
        .set(stripServerManagedColumns(data, SERVER_MANAGED_STYLE_COLUMNS))
        .where(and(eq(styles.id, styleId), eq(styles.teamId, teamId)))
        .returning();
      return Array.isArray(result) ? result[0] : undefined;
    },

    delete: async (styleId: string): Promise<void> => {
      await db
        .delete(styles)
        .where(and(eq(styles.id, styleId), eq(styles.teamId, teamId)));
    },

    incrementUsage: async (styleId: string): Promise<void> => {
      const rows = await db
        .update(styles)
        .set({ usageCount: sql`${styles.usageCount} + 1` })
        .where(eq(styles.id, styleId))
        .returning({ id: styles.id });
      if (rows.length === 0) {
        logger.warn('incrementUsage matched zero rows', { styleId });
      }
    },
  };
}
