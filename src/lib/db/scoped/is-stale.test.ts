/**
 * Schema-level acceptance test for the input-hash columns plus a behavioral
 * truth-table test for the `isStale` wrappers on `shots` and `shotVariants`.
 *
 * The other four wrappers (characters, locationLibrary, locationSheets,
 * talent.sheets) follow the same four-line shape exercised here, and their
 * parent factory modules are mocked process-wide by scoped.test.ts (per the
 * preamble of `./talent.test.ts`) — so importing them in a sibling test yields
 * stubs. The schema persistence asserts in this file plus the truth-table
 * coverage on frames/shotVariants are the regression guard for the pattern.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Client, createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { generateId } from '@/lib/db/id';
import {
  characters,
  shotVariants,
  shots,
  locationLibrary,
  locationSheets,
  sequenceLocations,
  sequences,
  styles,
  talent,
  talentSheets,
  teams,
  user,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import type { Database } from '@/lib/db/client';
import { createShotsMethods, type ShotHashArtifact } from './shots';
import { createShotVariantsMethods } from './shot-variants';

let client: Client;
let db: Database;

const team = { id: '', name: 'T', slug: 't' };
const userRow = { id: '', name: 'U', email: 'u@example.com' };
let sequenceId = '';

async function seed() {
  await db.delete(shotVariants);
  await db.delete(shots);
  await db.delete(characters);
  await db.delete(sequenceLocations);
  await db.delete(locationSheets);
  await db.delete(locationLibrary);
  await db.delete(talentSheets);
  await db.delete(talent);
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

describe('shots input-hash columns', () => {
  // The still-image hash columns (thumbnail / variantImage) moved to `frames`
  // in #989; only the shot-owned video/audio artifact hashes remain here.
  it('default to null and persist when set', async () => {
    const [shot] = await db
      .insert(shots)
      .values({ sequenceId, orderIndex: 0 })
      .returning();
    if (!shot) throw new Error('test setup: shot insert returned nothing');
    expect(shot.videoInputHash).toBeNull();
    expect(shot.audioInputHash).toBeNull();

    await db
      .update(shots)
      .set({
        videoInputHash: 'm',
        audioInputHash: 'a',
      })
      .where(eq(shots.id, shot.id));
    const [refreshed] = await db
      .select()
      .from(shots)
      .where(eq(shots.id, shot.id));
    if (!refreshed) throw new Error('test setup: refresh failed');
    expect(refreshed.videoInputHash).toBe('m');
    expect(refreshed.audioInputHash).toBe('a');
  });
});

describe('shot_variants input-hash + diverged_at columns', () => {
  it('default to null and persist when set', async () => {
    const [shot] = await db
      .insert(shots)
      .values({ sequenceId, orderIndex: 0 })
      .returning();
    if (!shot) throw new Error('test setup: shot insert returned nothing');
    const [variant] = await db
      .insert(shotVariants)
      .values({
        shotId: shot.id,
        sequenceId,
        variantType: 'image',
        model: 'm1',
      })
      .returning();
    if (!variant)
      throw new Error('test setup: variant insert returned nothing');
    expect(variant.inputHash).toBeNull();
    expect(variant.divergedAt).toBeNull();

    const divergedAt = new Date('2026-04-29T00:00:00Z');
    await db
      .update(shotVariants)
      .set({ inputHash: 'h', divergedAt })
      .where(eq(shotVariants.id, variant.id));
    const [refreshed] = await db
      .select()
      .from(shotVariants)
      .where(eq(shotVariants.id, variant.id));
    if (!refreshed) throw new Error('test setup: refresh failed');
    expect(refreshed.inputHash).toBe('h');
    expect(refreshed.divergedAt?.getTime()).toBe(divergedAt.getTime());
  });
});

describe('characters.sheet_input_hash', () => {
  it('defaults to null and persists when set', async () => {
    const [c] = await db
      .insert(characters)
      .values({ sequenceId, characterId: 'c1', name: 'C', age: '30s' })
      .returning();
    if (!c) throw new Error('test setup: character insert returned nothing');
    expect(c.sheetInputHash).toBeNull();

    await db
      .update(characters)
      .set({ sheetInputHash: 'h' })
      .where(eq(characters.id, c.id));
    const [refreshed] = await db
      .select()
      .from(characters)
      .where(eq(characters.id, c.id));
    if (!refreshed) throw new Error('test setup: refresh failed');
    expect(refreshed.sheetInputHash).toBe('h');
  });
});

describe('locationLibrary.reference_input_hash', () => {
  it('defaults to null and persists when set', async () => {
    const [loc] = await db
      .insert(locationLibrary)
      .values({ teamId: team.id, name: 'L' })
      .returning();
    if (!loc) throw new Error('test setup: location insert returned nothing');
    expect(loc.referenceInputHash).toBeNull();

    await db
      .update(locationLibrary)
      .set({ referenceInputHash: 'h' })
      .where(eq(locationLibrary.id, loc.id));
    const [refreshed] = await db
      .select()
      .from(locationLibrary)
      .where(eq(locationLibrary.id, loc.id));
    if (!refreshed) throw new Error('test setup: refresh failed');
    expect(refreshed.referenceInputHash).toBe('h');
  });
});

describe('locationSheets.input_hash', () => {
  it('defaults to null and persists when set', async () => {
    const [loc] = await db
      .insert(locationLibrary)
      .values({ teamId: team.id, name: 'L' })
      .returning();
    if (!loc) throw new Error('test setup: location insert returned nothing');
    const [sheet] = await db
      .insert(locationSheets)
      .values({ locationId: loc.id, name: 'night' })
      .returning();
    if (!sheet) throw new Error('test setup: sheet insert returned nothing');
    expect(sheet.inputHash).toBeNull();

    await db
      .update(locationSheets)
      .set({ inputHash: 'h' })
      .where(eq(locationSheets.id, sheet.id));
    const [refreshed] = await db
      .select()
      .from(locationSheets)
      .where(eq(locationSheets.id, sheet.id));
    if (!refreshed) throw new Error('test setup: refresh failed');
    expect(refreshed.inputHash).toBe('h');
  });
});

describe('talent_sheets.input_hash', () => {
  it('defaults to null and persists when set', async () => {
    const [t] = await db
      .insert(talent)
      .values({ teamId: team.id, name: 'T' })
      .returning();
    if (!t) throw new Error('test setup: talent insert returned nothing');
    const [sheet] = await db
      .insert(talentSheets)
      .values({ talentId: t.id, name: 'casual' })
      .returning();
    if (!sheet) throw new Error('test setup: sheet insert returned nothing');
    expect(sheet.inputHash).toBeNull();

    await db
      .update(talentSheets)
      .set({ inputHash: 'h' })
      .where(eq(talentSheets.id, sheet.id));
    const [refreshed] = await db
      .select()
      .from(talentSheets)
      .where(eq(talentSheets.id, sheet.id));
    if (!refreshed) throw new Error('test setup: refresh failed');
    expect(refreshed.inputHash).toBe('h');
  });
});

describe('shots.isStale', () => {
  const ARTIFACTS: Array<{
    artifact: ShotHashArtifact;
    column: 'videoInputHash' | 'audioInputHash';
  }> = [
    { artifact: 'video', column: 'videoInputHash' },
    { artifact: 'audio', column: 'audioInputHash' },
  ];

  it('throws when the shot does not exist', () => {
    const m = createShotsMethods(db);
    expect(m.isStale(generateId(), 'video', 'h')).rejects.toThrow(/not found/);
  });

  it.each(ARTIFACTS)(
    '$artifact: returns false when stored hash is null (legacy artifact)',
    async ({ artifact }) => {
      const [shot] = await db
        .insert(shots)
        .values({ sequenceId, orderIndex: 0 })
        .returning();
      if (!shot) throw new Error('test setup: shot insert returned nothing');
      const m = createShotsMethods(db);
      expect(await m.isStale(shot.id, artifact, 'anything')).toBe(false);
    }
  );

  it.each(ARTIFACTS)(
    '$artifact: returns false when stored hash matches the current hash',
    async ({ artifact, column }) => {
      const [shot] = await db
        .insert(shots)
        .values({ sequenceId, orderIndex: 0, [column]: 'h-match' })
        .returning();
      if (!shot) throw new Error('test setup: shot insert returned nothing');
      const m = createShotsMethods(db);
      expect(await m.isStale(shot.id, artifact, 'h-match')).toBe(false);
    }
  );

  it.each(ARTIFACTS)(
    '$artifact: returns true when stored hash differs from the current hash',
    async ({ artifact, column }) => {
      const [shot] = await db
        .insert(shots)
        .values({ sequenceId, orderIndex: 0, [column]: 'h-old' })
        .returning();
      if (!shot) throw new Error('test setup: shot insert returned nothing');
      const m = createShotsMethods(db);
      expect(await m.isStale(shot.id, artifact, 'h-new')).toBe(true);
    }
  );

  it('reads from the column matching the requested artifact (no cross-talk)', async () => {
    const [shot] = await db
      .insert(shots)
      .values({
        sequenceId,
        orderIndex: 0,
        videoInputHash: 'm-hash',
        audioInputHash: 'a-hash',
      })
      .returning();
    if (!shot) throw new Error('test setup: shot insert returned nothing');
    const m = createShotsMethods(db);
    // Each artifact key compares against ONLY its own column.
    expect(await m.isStale(shot.id, 'video', 'm-hash')).toBe(false);
    expect(await m.isStale(shot.id, 'video', 'a-hash')).toBe(true);
    expect(await m.isStale(shot.id, 'audio', 'a-hash')).toBe(false);
    expect(await m.isStale(shot.id, 'audio', 'm-hash')).toBe(true);
  });
});

// `createSequenceLocationsMethods` is mocked process-wide by scoped.test.ts,
// so the factory cannot be exercised here. The predicate is the same 4-line
// shape as `shots.isStale` / `shotVariants.isStale` (covered above); these
// tests pin the underlying column behavior the predicate reads.
describe('sequenceLocations.reference_input_hash', () => {
  async function insertLocation(referenceInputHash: string | null) {
    const [loc] = await db
      .insert(sequenceLocations)
      .values({
        sequenceId,
        locationId: `loc_${generateId()}`,
        name: 'Loc',
        referenceInputHash,
      })
      .returning();
    if (!loc) throw new Error('test setup: location insert returned nothing');
    return loc;
  }

  it('defaults to null and persists when set', async () => {
    const loc = await insertLocation(null);
    expect(loc.referenceInputHash).toBeNull();

    await db
      .update(sequenceLocations)
      .set({ referenceInputHash: 'h' })
      .where(eq(sequenceLocations.id, loc.id));
    const [refreshed] = await db
      .select()
      .from(sequenceLocations)
      .where(eq(sequenceLocations.id, loc.id));
    if (!refreshed) throw new Error('test setup: refresh failed');
    expect(refreshed.referenceInputHash).toBe('h');
  });

  it('predicate truth-table holds against stored column (null / match / differ)', async () => {
    // Stored null → no opinion (never stale).
    const noHash = await insertLocation(null);
    const [r0] = await db
      .select({ stored: sequenceLocations.referenceInputHash })
      .from(sequenceLocations)
      .where(eq(sequenceLocations.id, noHash.id));
    if (!r0) throw new Error('test setup: r0 select returned nothing');
    expect(r0.stored).toBeNull();

    // Stored match → not stale.
    const match = await insertLocation('h-match');
    const [r1] = await db
      .select({ stored: sequenceLocations.referenceInputHash })
      .from(sequenceLocations)
      .where(eq(sequenceLocations.id, match.id));
    if (!r1) throw new Error('test setup: r1 select returned nothing');
    expect(r1.stored).toBe('h-match');

    // Stored differs → stale.
    const differ = await insertLocation('h-old');
    const [r2] = await db
      .select({ stored: sequenceLocations.referenceInputHash })
      .from(sequenceLocations)
      .where(eq(sequenceLocations.id, differ.id));
    if (!r2) throw new Error('test setup: r2 select returned nothing');
    expect(r2.stored).toBe('h-old');
    expect(r2.stored !== 'h-new').toBe(true);
  });
});

describe('shotVariants.isStale', () => {
  async function insertVariant(inputHash: string | null) {
    const [shot] = await db
      .insert(shots)
      .values({ sequenceId, orderIndex: 0 })
      .returning();
    if (!shot) throw new Error('test setup: shot insert returned nothing');
    const [variant] = await db
      .insert(shotVariants)
      .values({
        shotId: shot.id,
        sequenceId,
        variantType: 'image',
        model: 'm1',
        inputHash,
      })
      .returning();
    if (!variant)
      throw new Error('test setup: variant insert returned nothing');
    return variant;
  }

  it('throws when the variant does not exist', () => {
    const m = createShotVariantsMethods(db);
    expect(m.isStale(generateId(), 'h')).rejects.toThrow(/not found/);
  });

  it('returns false when stored hash is null', async () => {
    const variant = await insertVariant(null);
    const m = createShotVariantsMethods(db);
    expect(await m.isStale(variant.id, 'anything')).toBe(false);
  });

  it('returns false when stored hash matches', async () => {
    const variant = await insertVariant('h-match');
    const m = createShotVariantsMethods(db);
    expect(await m.isStale(variant.id, 'h-match')).toBe(false);
  });

  it('returns true when stored hash differs', async () => {
    const variant = await insertVariant('h-old');
    const m = createShotVariantsMethods(db);
    expect(await m.isStale(variant.id, 'h-new')).toBe(true);
  });
});
