/**
 * Tests for the prompt-only studio create flow (#1274).
 *
 * Pins: sequence-model validation, credit gate before insert, one workflow
 * per requested image, trigger-failure marks the reserved row failed.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { generateId } from '@/lib/db/id';
import type { Database } from '@/lib/db/client';
import { generatedAssets, teams, user } from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import { studioCreateInputSchema } from '@/lib/studio/schema';

let db: Database;

const mockRequireCredits = vi.fn();
const mockTriggerWorkflow = vi.fn();
const mockRequireGenerationAllowed = vi.fn();
const mockGetEffectiveFalPricing = vi.fn();

vi.doMock('#db-client', () => ({ getDb: () => db }));
vi.doMock('@/lib/billing/preflight', () => ({
  requireCredits: mockRequireCredits,
}));
vi.doMock('@/lib/workflow/client', () => ({
  triggerWorkflow: mockTriggerWorkflow,
}));
vi.doMock('@/lib/compliance/generation-gate', () => ({
  requireGenerationAllowed: mockRequireGenerationAllowed,
}));
vi.doMock('@/lib/ai/fal-pricing-live', () => ({
  getEffectiveFalPricing: mockGetEffectiveFalPricing,
}));

const { createStudioAssets } = await import('@/lib/studio/create-studio-asset');
const { createScopedDb } = await import('@/lib/db/scoped');

const TEAM_ID = generateId();
const USER_ID = 'user-1';

beforeAll(async () => {
  const client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
  await db.insert(user).values([{ id: USER_ID, name: 'U', email: 'u@e.com' }]);
  await db.insert(teams).values([{ id: TEAM_ID, name: 'T', slug: 't' }]);
});

beforeEach(async () => {
  await db.delete(generatedAssets);
  vi.clearAllMocks();
  mockRequireCredits.mockResolvedValue(undefined);
  mockTriggerWorkflow.mockResolvedValue('wf-studio-1');
  mockRequireGenerationAllowed.mockResolvedValue(undefined);
  mockGetEffectiveFalPricing.mockResolvedValue({});
});

describe('studioCreateInputSchema', () => {
  it('accepts a prompt-only image request', () => {
    const parsed = studioCreateInputSchema.parse({
      activity: 'image',
      prompt: 'a red fox in fog',
      imageModel: 'gpt_image_2',
      aspectRatio: '16:9',
    });
    expect(parsed).toMatchObject({
      activity: 'image',
      count: 1,
      imageModel: 'gpt_image_2',
    });
  });

  it('rejects a hidden image model', () => {
    const result = studioCreateInputSchema.safeParse({
      activity: 'image',
      prompt: 'a red fox',
      imageModel: 'flux_2_turbo',
      aspectRatio: '16:9',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a catalog-only endpoint that is not a sequence model', () => {
    const result = studioCreateInputSchema.safeParse({
      activity: 'image',
      prompt: 'a red fox',
      imageModel: 'fal-ai/flux-1/dev',
      aspectRatio: '16:9',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a prompt-only video request without an image model', () => {
    const parsed = studioCreateInputSchema.parse({
      activity: 'video',
      prompt: 'the fox turns toward camera',
      videoModel: 'seedance_v2',
      aspectRatio: '9:16',
      duration: 5,
    });
    expect(parsed.activity).toBe('video');
    if (parsed.activity === 'video') {
      expect(parsed.videoModel).toBe('seedance_v2');
      expect(parsed).not.toHaveProperty('imageModel');
    }
  });
});

describe('createStudioAssets', () => {
  it('rejects a restricted account BEFORE the credit gate, leaving no row', async () => {
    const { AccountRestrictedError } = await import('@/lib/errors');
    mockRequireGenerationAllowed.mockRejectedValue(
      new AccountRestrictedError('paused')
    );
    const scopedDb = createScopedDb(TEAM_ID, USER_ID);

    await expect(
      createStudioAssets(scopedDb, {
        activity: 'image',
        prompt: 'a red fox',
        imageModel: 'gpt_image_2',
        aspectRatio: '16:9',
        count: 1,
        referenceImages: [],
      })
    ).rejects.toBeInstanceOf(AccountRestrictedError);

    expect(mockRequireCredits).not.toHaveBeenCalled();
    expect(await db.select().from(generatedAssets)).toEqual([]);
  });

  it('stops at the credit gate without inserting a row', async () => {
    mockRequireCredits.mockRejectedValueOnce(
      new Error('Insufficient credits for image generation')
    );
    const scopedDb = createScopedDb(TEAM_ID, USER_ID);

    await expect(
      createStudioAssets(scopedDb, {
        activity: 'image',
        prompt: 'a red fox',
        imageModel: 'gpt_image_2',
        aspectRatio: '16:9',
        count: 1,
        referenceImages: [],
      })
    ).rejects.toThrow('Insufficient credits');

    expect(mockTriggerWorkflow).not.toHaveBeenCalled();
    expect(await db.select().from(generatedAssets)).toEqual([]);
  });

  it('reserves one studio row per count and triggers /studio for each', async () => {
    mockTriggerWorkflow
      .mockResolvedValueOnce('wf-a')
      .mockResolvedValueOnce('wf-b');
    const scopedDb = createScopedDb(TEAM_ID, USER_ID);

    const result = await createStudioAssets(scopedDb, {
      activity: 'image',
      prompt: 'a red fox in fog',
      imageModel: 'gpt_image_2',
      aspectRatio: '16:9',
      count: 2,
      referenceImages: [],
    });

    expect(result.assets).toHaveLength(2);
    expect(result.assets.map((a) => a.workflowRunId)).toEqual(['wf-a', 'wf-b']);

    const rows = await db.select().from(generatedAssets);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.source === 'studio')).toBe(true);
    expect(rows.every((row) => row.activity === 'image')).toBe(true);
    expect(rows.every((row) => row.status === 'queued')).toBe(true);
    expect(rows[0]?.input).toMatchObject({
      prompt: 'a red fox in fog',
      aspectRatio: '16:9',
      imageModel: 'gpt_image_2',
    });

    expect(mockTriggerWorkflow).toHaveBeenCalledTimes(2);
    expect(mockTriggerWorkflow).toHaveBeenCalledWith(
      '/studio',
      expect.objectContaining({
        userId: USER_ID,
        teamId: TEAM_ID,
        activity: 'image',
        prompt: 'a red fox in fog',
        imageModel: 'gpt_image_2',
        aspectRatio: '16:9',
      }),
      expect.objectContaining({
        deduplicationId: expect.stringMatching(/^studio-/),
      })
    );
  });

  it('marks the reserved row failed when the workflow trigger throws', async () => {
    mockTriggerWorkflow.mockRejectedValueOnce(new Error('binding exploded'));
    const scopedDb = createScopedDb(TEAM_ID, USER_ID);

    await expect(
      createStudioAssets(scopedDb, {
        activity: 'image',
        prompt: 'a red fox',
        imageModel: 'gpt_image_2',
        aspectRatio: '16:9',
        count: 1,
        referenceImages: [],
      })
    ).rejects.toThrow('binding exploded');

    const rows = await db.select().from(generatedAssets);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.error).toMatch(/could not be started/);
    expect(rows[0]?.workflowRunId).toBeNull();
  });

  it('lists studio assets newest-first and can filter favorites', async () => {
    const scopedDb = createScopedDb(TEAM_ID, USER_ID);
    const first = await createStudioAssets(scopedDb, {
      activity: 'image',
      prompt: 'first',
      imageModel: 'gpt_image_2',
      aspectRatio: '16:9',
      count: 1,
      referenceImages: [],
    });
    const second = await createStudioAssets(scopedDb, {
      activity: 'image',
      prompt: 'second',
      imageModel: 'gpt_image_2',
      aspectRatio: '1:1',
      count: 1,
      referenceImages: [],
    });

    const newest = await scopedDb.generatedAssets.list({
      source: 'studio',
      order: 'newest',
    });
    expect(newest.assets.map((row) => row.id)).toEqual([
      second.assets[0]?.id,
      first.assets[0]?.id,
    ]);

    const oldest = await scopedDb.generatedAssets.list({
      source: 'studio',
      order: 'oldest',
    });
    expect(oldest.assets.map((row) => row.id)).toEqual([
      first.assets[0]?.id,
      second.assets[0]?.id,
    ]);

    const firstId = first.assets[0]?.id;
    if (!firstId) throw new Error('expected first asset');
    await scopedDb.generatedAssets.setFavorite(firstId, true);
    const favorites = await scopedDb.generatedAssets.list({
      source: 'studio',
      favoritesOnly: true,
    });
    expect(favorites.assets.map((row) => row.id)).toEqual([firstId]);
  });

  it('reserves a video row against the T2V endpoint with no image model', async () => {
    const scopedDb = createScopedDb(TEAM_ID, USER_ID);
    const result = await createStudioAssets(scopedDb, {
      activity: 'video',
      prompt: 'the fox turns toward camera',
      videoModel: 'seedance_v2',
      aspectRatio: '9:16',
      duration: 5,
      count: 1,
      mode: 'text',
      referenceImages: [],
      referenceVideos: [],
      referenceAudio: [],
    });

    expect(result.assets).toHaveLength(1);
    const rows = await db.select().from(generatedAssets);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.activity).toBe('video');
    expect(rows[0]?.endpointId).toBe(
      'bytedance/seedance-2.0/enterprise/v2/text-to-video'
    );
    expect(rows[0]?.input).toMatchObject({
      prompt: 'the fox turns toward camera',
      videoModel: 'seedance_v2',
      aspectRatio: '9:16',
    });
    expect(rows[0]?.input).not.toHaveProperty('imageModel');

    expect(mockTriggerWorkflow).toHaveBeenCalledWith(
      '/studio',
      expect.objectContaining({
        activity: 'video',
        prompt: 'the fox turns toward camera',
        videoModel: 'seedance_v2',
        aspectRatio: '9:16',
      }),
      expect.objectContaining({
        deduplicationId: expect.stringMatching(/^studio-/),
      })
    );
    expect(mockTriggerWorkflow.mock.calls[0]?.[1]).not.toHaveProperty(
      'imageModel'
    );
  });
});
