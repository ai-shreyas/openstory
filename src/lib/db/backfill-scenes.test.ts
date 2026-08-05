/**
 * In-memory DB tests for the #907 scenes backfill.
 *
 * The backfill is a data migration (INSERT … SELECT + UPDATE) that ships inside
 * the `…_jazzy_whiplash` migration. Because migrations run against an empty DB
 * at setup, the in-migration backfill no-ops there — so these tests seed shots
 * AFTER migrating, then execute the migration's own backfill statements (read
 * verbatim from the shipped SQL file) and assert the result. Reading the real
 * SQL keeps the test honest: it exercises exactly what runs in prod.
 *
 * The staleness-compat test is the milestone's #1 QA risk: a freshly-backfilled
 * shot must still report isStale() === false.
 */

import type { Scene } from '@/lib/ai/scene-analysis.schema';
import type { Database } from '@/lib/db/client';
import { generateId } from '@/lib/db/id';
import type { NewShot } from '@/lib/db/schema';
import {
  dbSceneId,
  scenes,
  sequences,
  shots,
  styles,
  teams,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import { createShotsMethods } from '@/lib/db/scoped/shots';
import { type Client, createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = './drizzle/migrations';

let client: Client;
let db: Database;
let teamId = '';
let sequenceId = '';

/**
 * Pull the backfill statements straight out of the shipped migration SQL so the
 * test runs the exact DML that prod applies. Finds the migration that contains
 * the `INSERT INTO scenes … SELECT … FROM shots` backfill, splits on drizzle's
 * statement breakpoint, and returns just the INSERT + UPDATE.
 */
function readBackfillStatements(): string[] {
  for (const dir of readdirSync(MIGRATIONS_DIR)) {
    const file = join(MIGRATIONS_DIR, dir, 'migration.sql');
    let sql: string;
    try {
      sql = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!sql.includes('INSERT INTO `scenes`')) continue;
    return sql
      .split('--> statement-breakpoint')
      .map((s) =>
        s
          .split('\n')
          .filter((line) => !line.trim().startsWith('--'))
          .join('\n')
          .trim()
      )
      .filter(
        (s) =>
          s.startsWith('INSERT INTO `scenes`') ||
          s.startsWith('UPDATE `shots` SET `scene_id`')
      );
  }
  throw new Error('test setup: backfill migration not found');
}

const BACKFILL_STATEMENTS = readBackfillStatements();

// Fail loud if the parser extracted the wrong number of statements (e.g. a
// future db:generate reformat that the startsWith filters no longer match).
// Without this, a partial match — INSERT found but UPDATE missed — would let
// the scene-only assertions pass while shot-linking goes untested.
if (BACKFILL_STATEMENTS.length !== 2) {
  throw new Error(
    `test setup: expected 2 backfill statements (INSERT scenes + UPDATE shots), got ${BACKFILL_STATEMENTS.length} — migration SQL format likely changed`
  );
}

async function runBackfill(): Promise<void> {
  for (const stmt of BACKFILL_STATEMENTS) {
    await client.execute(stmt);
  }
}

function sceneFixture(overrides: Partial<Scene> = {}): Scene {
  return {
    sceneId: 'scene-1',
    sceneNumber: 1,
    originalScript: { extract: 'INT. OFFICE - DAY', dialogue: [] },
    metadata: {
      title: 'The meeting',
      durationSeconds: 5,
      location: 'INT. OFFICE - DAY',
      timeOfDay: 'day',
      storyBeat: 'Setup',
    },
    continuity: {
      characterTags: ['sarah'],
      environmentTag: 'office',
      elementTags: [],
      colorPalette: 'cool blues',
      lightingSetup: 'overhead fluorescent',
      styleTag: 'corporate',
    },
    musicDesign: {
      presence: 'minimal',
      style: 'ambient',
      mood: 'tense',
      atmosphere: 'office hum',
    },
    ...overrides,
  };
}

async function seedSequence(): Promise<void> {
  teamId = generateId();
  sequenceId = generateId();
  await db.insert(teams).values({ id: teamId, name: 'T', slug: `t-${teamId}` });
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
  await db.insert(sequences).values({
    id: sequenceId,
    teamId,
    title: 'S',
    styleId: style.id,
  });
}

async function insertShot(data: Partial<NewShot> & { orderIndex: number }) {
  const [shot] = await db
    .insert(shots)
    .values({ sequenceId, ...data } satisfies NewShot)
    .returning();
  if (!shot) throw new Error('test setup: shot insert returned nothing');
  return shot;
}

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await db.delete(shots);
  await db.delete(scenes);
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);
  await seedSequence();
});

describe('backfill scenes migration', () => {
  it('creates one scene per shot, reusing the shot id, linked with shotNumber=1', async () => {
    const a = await insertShot({ orderIndex: 0, metadata: sceneFixture() });
    const b = await insertShot({
      orderIndex: 1,
      metadata: sceneFixture({ sceneId: 'scene-2', sceneNumber: 2 }),
    });

    await runBackfill();

    const allScenes = await db.select().from(scenes);
    expect(allScenes).toHaveLength(2);

    for (const shot of await db.select().from(shots)) {
      // The scene REUSES the shot's ULID — the 1:1 expand rule.
      expect(shot.sceneId).toBe(shot.id);
      expect(shot.shotNumber).toBe(1);
      const scene = allScenes.find((s) => s.id === shot.sceneId);
      expect(scene?.orderIndex).toBe(shot.orderIndex);
    }
    // Explicit id-reuse assertion against the known shots.
    expect(allScenes.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('splits scene-level fields out of the shot metadata onto the scene row', async () => {
    const shot = await insertShot({ orderIndex: 3, metadata: sceneFixture() });
    await runBackfill();

    const [scene] = await db
      .select()
      .from(scenes)
      // The scene reuses the shot's ULID (1:1 backfill), so the shot id doubles
      // as the scene's branded id — convert it explicitly at this boundary.
      .where(eq(scenes.id, dbSceneId(shot.id)));
    expect(scene?.orderIndex).toBe(3);
    expect(scene?.location).toBe('INT. OFFICE - DAY');
    expect(scene?.timeOfDay).toBe('day');
    expect(scene?.storyBeat).toBe('Setup');
    expect(scene?.title).toBe('The meeting');
    // JSON subtrees survive the json_extract round-trip with their shape intact.
    expect(scene?.continuity?.environmentTag).toBe('office');
    expect(scene?.continuity?.characterTags).toEqual(['sarah']);
    expect(scene?.musicDesign?.presence).toBe('minimal');
    expect(scene?.originalScript?.extract).toBe('INT. OFFICE - DAY');

    // The shot's metadata is left intact (transitional duplicate).
    const [reread] = await db.select().from(shots).where(eq(shots.id, shot.id));
    expect(reread?.metadata?.metadata?.location).toBe('INT. OFFICE - DAY');
  });

  it('backfills a null-metadata shot without crashing (null scene fields)', async () => {
    const shot = await insertShot({ orderIndex: 0, metadata: null });
    await runBackfill();

    const [scene] = await db.select().from(scenes);
    expect(scene?.id).toBe(shot.id);
    expect(scene?.location).toBeNull();
    expect(scene?.title).toBeNull();
    expect(scene?.continuity).toBeNull();
    expect(scene?.musicDesign).toBeNull();
    expect(scene?.originalScript).toBeNull();

    const [reread] = await db.select().from(shots).where(eq(shots.id, shot.id));
    expect(reread?.sceneId).toBe(shot.id);
    expect(reread?.shotNumber).toBe(1);
  });

  it('is idempotent: a second run creates no duplicate scenes', async () => {
    await insertShot({ orderIndex: 0, metadata: sceneFixture() });
    await insertShot({
      orderIndex: 1,
      metadata: sceneFixture({ sceneId: 'scene-2' }),
    });

    await runBackfill();
    expect(await db.select().from(scenes)).toHaveLength(2);

    // Second run: every shot already has a scene_id, so WHERE scene_id IS NULL
    // matches nothing — no new scenes, no constraint violation.
    await runBackfill();
    expect(await db.select().from(scenes)).toHaveLength(2);
    const allShots = await db.select().from(shots);
    expect(allShots.every((s) => s.sceneId === s.id)).toBe(true);
  });

  it('staleness compat: a freshly-backfilled shot is NOT stale', async () => {
    // A shot whose video artifact has a recorded input hash — the real path
    // where staleness matters. Backfill must not perturb it.
    const knownHash = 'abc123-video-input-hash';
    const shot = await insertShot({
      orderIndex: 0,
      metadata: sceneFixture(),
      videoInputHash: knownHash,
    });

    await runBackfill();

    const shotsMethods = createShotsMethods(db);
    // Same hash → not stale. Backfill touched only sceneId + shotNumber, so the
    // stored videoInputHash is unchanged.
    expect(await shotsMethods.isStale(shot.id, 'video', knownHash)).toBe(false);

    // Sanity: a different hash WOULD be stale, proving the check is live.
    expect(await shotsMethods.isStale(shot.id, 'video', 'different')).toBe(
      true
    );

    // And the stored hash itself survived the backfill untouched.
    const [reread] = await db.select().from(shots).where(eq(shots.id, shot.id));
    expect(reread?.videoInputHash).toBe(knownHash);
  });
});
