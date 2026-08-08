/**
 * In-memory DB test for the #1101 reclassify migration.
 *
 * The migration is a single data statement: legacy preview renders were filed
 * as `kind: 'model'` (the kind predates them), and this moves them to
 * `kind: 'preview'`. Because migrations run against an empty DB at setup, the
 * statement no-ops there — so this seeds the legacy row shapes AFTER migrating,
 * then executes the shipped SQL verbatim and asserts exactly which rows moved.
 *
 * The discriminators are the whole risk: get one wrong and a real still becomes
 * unselectable, or a preview stays in the user's model dropdown.
 */

import { generateId } from '@/lib/db/id';
import {
  frameVariants,
  frames,
  sequences,
  shots,
  styles,
  teams,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import { type Client, createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';

const MIGRATION_SQL =
  './drizzle/migrations/20260808000000_reclassify_preview_variants/migration.sql';

/** The shipped statement, comments stripped. */
function readMigration(): string {
  return readFileSync(MIGRATION_SQL, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .trim();
}

function required<T>(row: T | undefined, what: string): T {
  if (!row) throw new Error(`test setup: ${what} insert returned nothing`);
  return row;
}

let client: Client;

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  const db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });

  const teamId = generateId();
  const sequenceId = generateId();
  await db.insert(teams).values({ id: teamId, name: 'T', slug: 't' });
  const style = required(
    (
      await db
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
        .returning()
    )[0],
    'style'
  );
  await db
    .insert(sequences)
    .values({ id: sequenceId, teamId, title: 'S', styleId: style.id });
  const shot = required(
    (
      await db.insert(shots).values({ sequenceId, shotNumber: 1 }).returning()
    )[0],
    'shot'
  );
  const frame = required(
    (
      await db
        .insert(frames)
        .values({ shotId: shot.id, sequenceId, orderIndex: 0, role: 'first' })
        .returning()
    )[0],
    'frame'
  );

  const base = { frameId: frame.id, sequenceId } as const;
  await db.insert(frameVariants).values([
    // Moves: the shape every one of the legacy rows has.
    { ...base, id: 'legacy-preview', kind: 'model', model: 'flux_2_turbo' },
    // Stays: a real still from a user-pickable model.
    { ...base, id: 'real-still', kind: 'model', model: 'nano_banana_2' },
    // Stays: a 3x3 grid sheet was never a preview, whatever rendered it.
    { ...base, id: 'framing', kind: 'framing', model: 'flux_2_turbo' },
    // Stays: a render OF a prompt version is a still, not a preview.
    {
      ...base,
      id: 'with-prompt',
      kind: 'model',
      model: 'flux_2_turbo',
      promptVersionId: 'pv-1',
    },
    // Stays: a frame points at it, so it is that frame's still by definition —
    // moving it would strand the pointer against the new `select` guard.
    { ...base, id: 'selected', kind: 'model', model: 'flux_2_turbo' },
  ]);
  await db
    .update(frames)
    .set({ selectedImageVersionId: 'selected' })
    .where(eq(frames.id, frame.id));

  const sql = readMigration();
  await client.execute(sql);
  // Replay safety: a second application must move nothing more.
  await client.execute(sql);
});

afterAll(() => {
  client.close();
});

it('reclassifies only the legacy preview rows', async () => {
  const rows = await client.execute(
    'SELECT id, kind FROM frame_variants ORDER BY id'
  );
  expect(Object.fromEntries(rows.rows.map((r) => [r.id, r.kind]))).toEqual({
    framing: 'framing',
    'legacy-preview': 'preview',
    'real-still': 'model',
    selected: 'model',
    'with-prompt': 'model',
  });
});
