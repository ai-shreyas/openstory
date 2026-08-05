/**
 * Behavioral test for anchor-frame materialization on shot writes.
 *
 * `upsert` / `bulkUpsert` / `ensureAnchorFrames` return each shot's anchor frame
 * id (orderIndex 0), captured at write time so prompt workflows can thread it
 * downstream instead of reading it back (#991). The critical guarantee is that
 * this stays correct AND stable across a replay: re-running the same write must
 * return the SAME anchor id (the conflicting insert re-emits the existing row
 * via the no-op onConflictDoUpdate, not a fresh frame).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Client, createClient } from '@libsql/client';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { generateId } from '@/lib/db/id';
import { frames, sequences, styles, teams } from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import type { Database } from '@/lib/db/client';
import { createShotsMethods } from './shots';

let client: Client;
let db: Database;
let teamId = '';
let sequenceId = '';

async function seed() {
  await db.delete(frames);
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);

  teamId = generateId();
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

describe('shots anchor-frame materialization', () => {
  it('upsert returns the anchor frame id (a real, distinct-from-shot id)', async () => {
    const methods = createShotsMethods(db);
    const shot = await methods.upsert({ sequenceId, orderIndex: 0 });

    expect(shot.anchorFrameId).toBeTruthy();
    // Frames get their own id — never the shot id (id-reuse is a migration
    // artifact only, see shots.ts anchorFrameValues).
    expect(shot.anchorFrameId).not.toBe(shot.id);

    const [anchor] = await db
      .select()
      .from(frames)
      .where(and(eq(frames.shotId, shot.id), eq(frames.orderIndex, 0)));
    expect(anchor?.id).toBe(shot.anchorFrameId);
  });

  it('re-upserting the same shot returns the SAME anchor id (replay-stable)', async () => {
    const methods = createShotsMethods(db);
    const first = await methods.upsert({ sequenceId, orderIndex: 0 });
    const replay = await methods.upsert({ sequenceId, orderIndex: 0 });

    // Same shot row (unique on sequenceId+orderIndex) and same anchor frame —
    // the conflict path must not mint a new frame.
    expect(replay.id).toBe(first.id);
    expect(replay.anchorFrameId).toBe(first.anchorFrameId);

    const anchorRows = await db
      .select()
      .from(frames)
      .where(and(eq(frames.shotId, first.id), eq(frames.orderIndex, 0)));
    expect(anchorRows).toHaveLength(1);
  });

  it('bulkUpsert returns an anchor id per shot', async () => {
    const methods = createShotsMethods(db);
    const shots = await methods.bulkUpsert([
      { sequenceId, orderIndex: 0 },
      { sequenceId, orderIndex: 1 },
    ]);

    expect(shots).toHaveLength(2);
    const anchorIds = shots.map((s) => s.anchorFrameId);
    expect(anchorIds.every(Boolean)).toBe(true);
    // Distinct shots get distinct anchor frames.
    expect(new Set(anchorIds).size).toBe(2);
  });

  it('ensureAnchorFrames returns an anchor id for every shot across chunk boundaries', async () => {
    // #1019: the read path (getShotsFn) calls ensureAnchorFrames with a whole
    // sequence's shots at once. A single INSERT of >~10 anchor rows overflowed
    // D1's 100-bound-parameter ceiling, so it now chunks. Use more shots than
    // the internal batch size to prove the per-chunk RETURNING maps are merged.
    const methods = createShotsMethods(db);
    const shots = await methods.createBulk(
      Array.from({ length: 25 }, (_, i) => ({ sequenceId, orderIndex: i }))
    );
    const anchors = await methods.ensureAnchorFrames(shots);

    expect(anchors.size).toBe(shots.length);
    for (const shot of shots) {
      expect(anchors.get(shot.id)).toBeTruthy();
    }
  });

  it('preserves an existing anchor frame and its image on replay', async () => {
    const methods = createShotsMethods(db);
    const shot = await methods.upsert({ sequenceId, orderIndex: 0 });
    // Simulate a generated image landing on the anchor between writes.
    await db
      .update(frames)
      .set({ imageUrl: 'https://example.test/anchor.png' })
      .where(eq(frames.id, shot.anchorFrameId));

    await methods.upsert({ sequenceId, orderIndex: 0 });

    const [anchor] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, shot.anchorFrameId));
    expect(anchor?.imageUrl).toBe('https://example.test/anchor.png');
  });
});
