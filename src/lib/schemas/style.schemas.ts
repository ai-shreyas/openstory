import {
  StyleConfigSchema,
  styles,
  StyleSampleVideoSchema,
} from '@/lib/db/schema';
import { createInsertSchema, createUpdateSchema } from 'drizzle-orm/zod';
import { z } from 'zod';

/**
 * Shared Zod schemas for style operations
 */

const tagsSchema = z.array(z.string()).nullish();
const useCasesSchema = z.array(z.string()).nullish();
const sampleVideosSchema = z.array(StyleSampleVideoSchema).nullish();

// Columns the client must never set. usageCount is server-managed (popularity
// ranking), id/teamId/createdBy/createdAt/updatedAt are injected by the scoped
// layer, and public/template flags, version, and sortOrder are
// admin/migration-only.
// Exported so the scoped-db write methods can exclude the same columns at
// the type level AND scrub them at runtime — a column added here is enforced
// in all three places at once.
export const SERVER_MANAGED_STYLE_COLUMNS = {
  id: true,
  teamId: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
  usageCount: true,
  version: true,
  isPublic: true,
  isTemplate: true,
  sortOrder: true,
} as const;

export type ServerManagedStyleColumn =
  keyof typeof SERVER_MANAGED_STYLE_COLUMNS;

export const createStyleSchema = createInsertSchema(styles, {
  config: () => StyleConfigSchema,
  tags: () => tagsSchema,
  useCases: () => useCasesSchema,
  sampleVideos: () => sampleVideosSchema,
}).omit(SERVER_MANAGED_STYLE_COLUMNS);
export const updateStyleSchema = createUpdateSchema(styles, {
  config: () => StyleConfigSchema.optional(),
  tags: () => tagsSchema,
  useCases: () => useCasesSchema,
  sampleVideos: () => sampleVideosSchema,
}).omit(SERVER_MANAGED_STYLE_COLUMNS);
