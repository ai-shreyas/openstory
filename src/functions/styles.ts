/**
 * Style Server Functions
 * End-to-end type-safe functions for style library operations
 */

import { requireTeamAdminAccess } from '@/lib/auth/action-utils';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import {
  createStyleSchema,
  updateStyleSchema,
} from '@/lib/schemas/style.schemas';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithTeamMiddleware } from './middleware';
export { getPublicStylesFn } from './public-styles';

// ============================================================================
// List Styles
// ============================================================================

/**
 * Get all styles accessible to the user (team + public)
 * @returns Array of styles
 */
export const getStylesFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .validator(
    zodValidator(
      z
        .object({ orderBy: z.enum(['popular', 'sortOrder']).optional() })
        .optional()
    )
  )
  .handler(async ({ data, context }) => {
    return context.scopedDb.styles.list({ orderBy: data?.orderBy });
  });

// ============================================================================
// Get Single Style
// ============================================================================

const getStyleInputSchema = z.object({
  styleId: ulidSchema,
});

/**
 * Get a single style by ID
 * @returns The style
 */
export const getStyleFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(getStyleInputSchema))
  .handler(async ({ data, context }) => {
    // Style lookup doesn't require team scoping (styles can be public)
    const style = await context.scopedDb.styles.getById(data.styleId);

    if (!style) {
      throw new Error('Style not found');
    }

    return style;
  });

// ============================================================================
// Create Style
// ============================================================================

/**
 * Create a new style
 * @returns The created style
 */
export const createStyleFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(createStyleSchema))
  .handler(async ({ data, context }) => {
    return context.scopedDb.styles.create(data);
  });

// ============================================================================
// Update Style
// ============================================================================

const updateStyleInputSchema = updateStyleSchema.extend({
  styleId: ulidSchema,
});

/**
 * Update a style
 * @returns The updated style
 */
export const updateStyleFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(updateStyleInputSchema))
  .handler(async ({ data, context }) => {
    const { styleId, ...updateData } = data;

    const style = await context.scopedDb.styles.update(styleId, updateData);

    if (!style) {
      throw new Error(
        'Style not found or you do not have permission to update it'
      );
    }

    return style;
  });

// ============================================================================
// Delete Style
// ============================================================================

const deleteStyleInputSchema = z.object({
  styleId: ulidSchema,
});

/**
 * Delete a style (requires admin/owner role)
 */
export const deleteStyleFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(deleteStyleInputSchema))
  .handler(async ({ data, context }) => {
    // Style lookup without team scoping (need to discover the team first)
    const style = await context.scopedDb.styles.getById(data.styleId);

    if (!style) {
      throw new Error('Style not found');
    }

    await requireTeamAdminAccess(context.user.id, style.teamId);

    await context.scopedDb.styles.delete(data.styleId);

    return { success: true };
  });
