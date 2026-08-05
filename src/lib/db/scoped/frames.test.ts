/**
 * Acceptance tests for the frames helper. In-memory libSQL with the real
 * migrations. Covers upsert idempotency (workflow-replay safety), isStale
 * null-hash semantics, resolveCurrent, and that the generic `update` path does
 * not move the selection pointer / mirror columns (drift prevention — those
 * live on `frameVariants.select` / `framePromptVersions`).
 */

import type { Database } from '@/lib/db/client';
import { generateId } from '@/lib/db/id';
import {
  frameVariants,
  frames,
  sequences,
  shots,
  styles,
  teams,
  user,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import { type Client, createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFramesMethods } from './frames';

let client: Client;
let db: Database;
let sequenceId = '';
let shotId = '';

async function seed() {
  await db.delete(frameVariants);
  await db.delete(frames);
  await db.delete(shots);
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);
  await db.delete(user);

  const teamId = generateId();
  sequenceId = generateId();
  await db.insert(teams).values({ id: teamId, name: 'T', slug: 't' });
  const [style] = await db
    .insert(styles)
    .values({
      teamId,
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
    .values({ id: sequenceId, teamId, title: 'S', styleId: style.id });
  const [shot] = await db
    .insert(shots)
    .values({ sequenceId, orderIndex: 0 })
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

describe('frames.upsert', () => {
  it('is idempotent on (shotId, orderIndex) — a replay updates in place', async () => {
    const m = createFramesMethods(db);
    const first = await m.upsert({
      shotId,
      sequenceId,
      orderIndex: 0,
      role: 'first',
    });
    const replay = await m.upsert({
      shotId,
      sequenceId,
      orderIndex: 0,
      role: 'first',
    });
    expect(replay.id).toBe(first.id);
    expect(await m.listByShot(shotId)).toHaveLength(1);
  });
});

describe('frames.update', () => {
  it('updates non-mirror fields without disturbing the selection pointer', async () => {
    const m = createFramesMethods(db);
    const frame = await m.create({
      shotId,
      sequenceId,
      orderIndex: 0,
      role: 'first',
    });
    // Seed a pointer + mirror as the select path would.
    await db
      .update(frames)
      .set({
        selectedImageVersionId: 'ver-1',
        imageUrl: 'https://cdn/keep.png',
        imageInputHash: 'keep-hash',
      })
      .where(eq(frames.id, frame.id));

    await m.update(frame.id, { orderIndex: 2, role: 'key' });

    const [refreshed] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frame.id));
    if (!refreshed) throw new Error('test setup: refresh failed');
    expect(refreshed.orderIndex).toBe(2);
    expect(refreshed.role).toBe('key');
    // Mirror columns untouched.
    expect(refreshed.selectedImageVersionId).toBe('ver-1');
    expect(refreshed.imageUrl).toBe('https://cdn/keep.png');
    expect(refreshed.imageInputHash).toBe('keep-hash');
  });

  it('throws on a missing frame by default, returns undefined when opted out', async () => {
    const m = createFramesMethods(db);
    await expect(m.update(generateId(), { orderIndex: 1 })).rejects.toThrow(
      /not found/
    );
    expect(
      await m.update(generateId(), { orderIndex: 1 }, { throwOnMissing: false })
    ).toBeUndefined();
  });
});

describe('frames.resolveCurrent', () => {
  it('returns the frame with a null selectedVersion when unselected', async () => {
    const m = createFramesMethods(db);
    const frame = await m.create({
      shotId,
      sequenceId,
      orderIndex: 0,
      role: 'first',
    });
    const resolved = await m.resolveCurrent(frame.id);
    expect(resolved?.frame.id).toBe(frame.id);
    expect(resolved?.selectedVersion).toBeNull();
  });

  it('returns null for a missing frame', async () => {
    const m = createFramesMethods(db);
    expect(await m.resolveCurrent(generateId())).toBeNull();
  });

  it('resolves the pointed-at version', async () => {
    const m = createFramesMethods(db);
    const frame = await m.create({
      shotId,
      sequenceId,
      orderIndex: 0,
      role: 'first',
    });
    const [version] = await db
      .insert(frameVariants)
      .values({
        frameId: frame.id,
        sequenceId,
        kind: 'model',
        model: 'm1',
        status: 'completed',
      })
      .returning();
    if (!version)
      throw new Error('test setup: version insert returned nothing');
    await db
      .update(frames)
      .set({ selectedImageVersionId: version.id })
      .where(eq(frames.id, frame.id));

    const resolved = await m.resolveCurrent(frame.id);
    expect(resolved?.selectedVersion?.id).toBe(version.id);
  });
});

describe('frames.isStale', () => {
  it('throws when the frame does not exist', () => {
    const m = createFramesMethods(db);
    expect(m.isStale(generateId(), 'h')).rejects.toThrow(/not found/);
  });

  it('null stored hash → not stale; match → not stale; differ → stale', async () => {
    const m = createFramesMethods(db);
    const a = await m.create({ shotId, sequenceId, orderIndex: 0 });
    expect(await m.isStale(a.id, 'anything')).toBe(false);

    await db
      .update(frames)
      .set({ imageInputHash: 'h-match' })
      .where(eq(frames.id, a.id));
    expect(await m.isStale(a.id, 'h-match')).toBe(false);
    expect(await m.isStale(a.id, 'h-new')).toBe(true);
  });
});
