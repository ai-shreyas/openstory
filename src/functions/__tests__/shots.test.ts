/**
 * Tests for the promote/discard server-fn orchestration.
 *
 * The TanStack server-fn middleware chain (auth, shot access, scoped DB)
 * is exercised end-to-end by the e2e suite; here we cover the new logic
 * added in #625:
 *   - The pure per-variantType update builder (buildPromoteUpdate).
 *   - The atomic shot-update + variant-discard pair via the new scoped
 *     `promoteAtomically` method, including its all-or-nothing semantics.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Client, createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { generateId } from '@/lib/db/id';
import {
  shotVariants,
  shots,
  sequences,
  styles,
  teams,
  user,
} from '@/lib/db/schema';
import type { ShotVariant } from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import type { Database } from '@/lib/db/client';
import { createShotVariantsMethods } from '@/lib/db/scoped/shot-variants';
import { buildPromoteUpdate } from '@/functions/shots';

const baseVariant = (overrides: Partial<ShotVariant> = {}): ShotVariant => ({
  id: 'v1',
  shotId: 'f1',
  sequenceId: 's1',
  variantType: 'image',
  model: 'flux',
  url: 'https://example.com/v1.png',
  storagePath: 'variants/v1.png',
  previewUrl: null,
  shotVariantUrl: null,
  shotVariantPath: null,
  shotVariantStatus: 'pending',
  shotVariantWorkflowRunId: null,
  status: 'completed',
  workflowRunId: null,
  generatedAt: new Date(),
  error: null,
  promptHash: null,
  inputHash: 'hash-abc',
  divergedAt: new Date('2026-04-01T00:00:00Z'),
  discardedAt: null,
  durationMs: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('buildPromoteUpdate', () => {
  it('image variant: throws — image promotion is retired (#989), selection is a frameVariants.select repoint', () => {
    const variant = baseVariant({ variantType: 'image' });
    // Image variants moved to `frame_variants`; the still is chosen by a
    // pointer repoint (`frameVariants.select`), never copied onto `shots`.
    expect(() => buildPromoteUpdate(variant)).toThrow(/not promoted/);
  });

  it('video variant: copies video fields only', () => {
    const variant = baseVariant({ variantType: 'video' });
    const { update, progressEvent, progressUrlField } =
      buildPromoteUpdate(variant);

    expect(update.videoUrl).toBe(variant.url);
    expect(update.videoPath).toBe(variant.storagePath);
    expect(update.videoStatus).toBe('completed');
    expect(update.videoError).toBeNull();
    expect(update.videoInputHash).toBe(variant.inputHash);

    expect(update.audioUrl).toBeUndefined();

    expect(progressEvent).toBe('video:progress');
    expect(progressUrlField).toBe('videoUrl');
  });

  it('audio variant: copies audio fields only', () => {
    const variant = baseVariant({ variantType: 'audio' });
    const { update, progressEvent, progressUrlField } =
      buildPromoteUpdate(variant);

    expect(update.audioUrl).toBe(variant.url);
    expect(update.audioPath).toBe(variant.storagePath);
    expect(update.audioStatus).toBe('completed');
    expect(update.audioError).toBeNull();
    expect(update.audioInputHash).toBe(variant.inputHash);

    expect(update.videoUrl).toBeUndefined();

    expect(progressEvent).toBe('audio:progress');
    expect(progressUrlField).toBe('audioUrl');
  });
});

let client: Client;
let db: Database;
const team = { id: '', name: 'T', slug: 't' };
const userRow = { id: '', name: 'U', email: 'u@example.com' };
let sequenceId = '';
let shotId = '';

async function seed() {
  await db.delete(shotVariants);
  await db.delete(shots);
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);
  await db.delete(user);

  team.id = generateId();
  userRow.id = generateId();
  sequenceId = generateId();

  await db.insert(user).values([userRow]);
  await db.insert(teams).values([team]);
  const [style] = await db
    .insert(styles)
    .values({
      teamId: team.id,
      name: 'default',
      config: {
        mood: 'neutral',
        artStyle: 'cinematic',
        lighting: 'natural',
        colorPalette: ['#000', '#fff'],
        cameraWork: 'static',
        referenceFilms: [],
        colorGrading: 'neutral',
      },
    })
    .returning();
  if (!style) throw new Error('test setup: style insert returned nothing');
  await db
    .insert(sequences)
    .values([
      { id: sequenceId, teamId: team.id, title: 'S', styleId: style.id },
    ]);
  const [shot] = await db
    .insert(shots)
    .values({
      sequenceId,
      orderIndex: 0,
      videoUrl: 'https://live/old.mp4',
      videoStatus: 'completed',
    })
    .returning();
  if (!shot) throw new Error('test setup: shot insert returned nothing');
  shotId = shot.id;
}

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await seed();
});

describe('shotVariants.promoteAtomically', () => {
  // Image variants no longer live on `shot_variants` (#989), so the
  // promote-atomically path now only serves video/audio. Exercise it with a
  // divergent VIDEO alternate.
  async function insertDivergent(opts: {
    inputHash: string;
    url: string;
    variantType?: 'video' | 'audio';
  }) {
    const [variant] = await db
      .insert(shotVariants)
      .values({
        shotId,
        sequenceId,
        variantType: opts.variantType ?? 'video',
        model: 'm1',
        url: opts.url,
        status: 'completed',
        inputHash: opts.inputHash,
        divergedAt: new Date('2026-04-29T00:00:00Z'),
      })
      .returning();
    if (!variant)
      throw new Error('test setup: variant insert returned nothing');
    return variant;
  }

  it('promotes video: updates shot video and discards variant in one batch', async () => {
    const variant = await insertDivergent({
      inputHash: 'h1',
      url: 'https://alt/v1.mp4',
    });
    const methods = createShotVariantsMethods(db);

    const { update } = buildPromoteUpdate(variant);
    const result = await methods.promoteAtomically(shotId, update, variant.id);

    expect(result.shot.videoUrl).toBe('https://alt/v1.mp4');
    expect(result.shot.videoStatus).toBe('completed');
    expect(result.discardedAt).toBeInstanceOf(Date);

    const after = await methods.getById(variant.id);
    expect(after?.discardedAt).toBeInstanceOf(Date);
    // Variant falls out of the divergent listing once discardedAt is set.
    const stillDivergent = await methods.listDivergentByShot(shotId, 'video');
    expect(stillDivergent.map((r) => r.id)).not.toContain(variant.id);
  });

  it('throws when shot does not exist; variant is not soft-deleted', async () => {
    const variant = await insertDivergent({
      inputHash: 'h2',
      url: 'https://alt/v2.mp4',
    });
    const methods = createShotVariantsMethods(db);

    expect(
      methods.promoteAtomically(generateId(), { videoUrl: 'x' }, variant.id)
    ).rejects.toThrow('not found');

    // Both writes go through db.batch, so a missing shot must roll back the
    // variant discard — promote is all-or-nothing.
    const after = await methods.getById(variant.id);
    expect(after?.discardedAt).toBeNull();
  });

  it('throws when variant does not exist; shot is not updated', async () => {
    const methods = createShotVariantsMethods(db);

    expect(
      methods.promoteAtomically(
        shotId,
        { videoUrl: 'should-not-stick' },
        generateId()
      )
    ).rejects.toThrow('not found');

    const [shotAfter] = await db
      .select()
      .from(shots)
      .where(eq(shots.id, shotId));
    if (!shotAfter) throw new Error('test setup: shot lookup returned nothing');
    expect(shotAfter.videoUrl).toBe('https://live/old.mp4');
  });
});
