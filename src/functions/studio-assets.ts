/**
 * Prompt-only Images and Videos (#1274).
 *
 * Team-scoped create/list/get/favorite/delete for studio `generated_assets`.
 * Always on — unlike `/models` this is not gated by MODELS_ENABLED. Create
 * lives in `@/lib/studio/create-studio-asset` so the Start compiler does not
 * ship the workflow client into the browser bundle (#1257).
 */

import { createStudioAssets } from '@/lib/studio/create-studio-asset';
import { studioCreateInputSchema } from '@/lib/studio/schema';
import { GENERATED_ASSET_ACTIVITIES } from '@/lib/db/schema';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithTeamMiddleware } from './middleware';

export const createStudioAssetsFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(studioCreateInputSchema))
  .handler(async ({ context, data }) => {
    return createStudioAssets(context.scopedDb, data);
  });

const listStudioAssetsInputSchema = z.object({
  activity: z.enum(GENERATED_ASSET_ACTIVITIES).optional(),
  favoritesOnly: z.boolean().optional(),
  order: z.enum(['newest', 'oldest']).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: ulidSchema.optional(),
});

export const listStudioAssetsFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(listStudioAssetsInputSchema.optional()))
  .handler(async ({ context, data }) => {
    return context.scopedDb.generatedAssets.list({
      source: 'studio',
      activity: data?.activity,
      favoritesOnly: data?.favoritesOnly,
      order: data?.order,
      limit: data?.limit,
      cursor: data?.cursor,
    });
  });

export const getStudioAssetFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(z.object({ id: ulidSchema })))
  .handler(async ({ context, data }) => {
    const asset = await context.scopedDb.generatedAssets.getById(data.id);
    if (!asset || asset.source !== 'studio') {
      throw new Error('Generated asset not found');
    }
    return asset;
  });

export const setStudioAssetFavoriteFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(
    zodValidator(
      z.object({
        id: ulidSchema,
        isFavorite: z.boolean(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const asset = await context.scopedDb.generatedAssets.getById(data.id);
    if (!asset || asset.source !== 'studio') {
      throw new Error('Generated asset not found');
    }
    await context.scopedDb.generatedAssets.setFavorite(
      data.id,
      data.isFavorite
    );
    return { id: data.id, isFavorite: data.isFavorite };
  });

export const deleteStudioAssetFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(z.object({ id: ulidSchema })))
  .handler(async ({ context, data }) => {
    const asset = await context.scopedDb.generatedAssets.getById(data.id);
    if (!asset || asset.source !== 'studio') {
      throw new Error('Generated asset not found');
    }
    await context.scopedDb.generatedAssets.delete(data.id);
    return { id: data.id };
  });
