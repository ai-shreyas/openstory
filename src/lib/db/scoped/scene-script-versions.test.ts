import type { Database } from '@/lib/db/client';
import { generateId } from '@/lib/db/id';
import {
  dbSceneId,
  sceneScriptVersions,
  scenes,
  sequences,
  styles,
  teams,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import { createSceneScriptVersionsMethods } from '@/lib/db/scoped/scene-script-versions';
import { type Client, createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let client: Client;
let db: Database;
let teamId = '';
let sequenceId = '';
let sceneId = dbSceneId('');

async function seedScene(orderIndex = 0, extract = 'Scene one.') {
  sceneId = dbSceneId(generateId());
  await db.insert(scenes).values({
    id: sceneId,
    sequenceId,
    orderIndex,
    originalScript: { extract, dialogue: [] },
  });
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
  teamId = generateId();
  sequenceId = generateId();

  await db
    .insert(teams)
    .values({ id: teamId, name: 'Test Team', slug: `test-${teamId}` });
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
    title: 'Seq',
    script: 'Full script',
    styleId: style.id,
  });
  await seedScene();
});

describe('sceneScriptVersions.write', () => {
  it('appends a version and repoints the scene selection', async () => {
    const methods = createSceneScriptVersionsMethods(db);
    const version = await methods.write({
      sceneId,
      content: { extract: 'Scene one.', dialogue: [] },
      source: 'split',
    });

    const [scene] = await db
      .select()
      .from(scenes)
      .where(eq(scenes.id, sceneId));
    expect(scene?.selectedScriptVersionId).toBe(version.id);

    const edit = await methods.write({
      sceneId,
      content: { extract: 'Edited scene.', dialogue: [] },
      source: 'edit',
    });
    const [sceneAfterEdit] = await db
      .select()
      .from(scenes)
      .where(eq(scenes.id, sceneId));
    expect(sceneAfterEdit?.selectedScriptVersionId).toBe(edit.id);

    const history = await methods.listByScene(sceneId);
    expect(history).toHaveLength(2);
  });

  it('lists selected scripts in sequence order', async () => {
    const scene2Id = dbSceneId(generateId());
    await db.insert(scenes).values({
      id: scene2Id,
      sequenceId,
      orderIndex: 1,
      originalScript: { extract: 'Scene two.', dialogue: [] },
    });

    const methods = createSceneScriptVersionsMethods(db);
    await methods.write({
      sceneId,
      content: { extract: 'Scene one.', dialogue: [] },
      source: 'split',
    });
    await methods.write({
      sceneId: scene2Id,
      content: { extract: 'Scene two.', dialogue: [] },
      source: 'split',
    });

    const rows = await methods.listSelectedBySequence(sequenceId);
    expect(rows.map((r) => r.version.content.extract)).toEqual([
      'Scene one.',
      'Scene two.',
    ]);
  });
});

describe('sceneScriptVersions.seedSplitFromSceneRows', () => {
  it('bulk-seeds split versions and repoints selection using scene row ids', async () => {
    const scene2Id = dbSceneId(generateId());
    await db.insert(scenes).values({
      id: scene2Id,
      sequenceId,
      orderIndex: 1,
      originalScript: { extract: 'Scene two.', dialogue: [] },
    });

    const methods = createSceneScriptVersionsMethods(db);
    const sceneRows = await db
      .select()
      .from(scenes)
      .where(eq(scenes.sequenceId, sequenceId));

    const inserted = await methods.seedSplitFromSceneRows(sceneRows);
    expect(inserted).toBe(2);

    for (const row of sceneRows) {
      const [scene] = await db
        .select()
        .from(scenes)
        .where(eq(scenes.id, row.id));
      expect(scene?.selectedScriptVersionId).toBe(row.id);

      const [version] = await db
        .select()
        .from(sceneScriptVersions)
        .where(eq(sceneScriptVersions.id, row.id));
      expect(version?.source).toBe('split');
      expect(version?.content.extract).toBe(row.originalScript?.extract);
    }

    const listed = await methods.listSelectedBySequence(sequenceId);
    expect(listed.map((r) => r.version.content.extract)).toEqual([
      'Scene one.',
      'Scene two.',
    ]);
  });

  it('skips rows without originalScript and is idempotent on replay', async () => {
    const noScriptId = dbSceneId(generateId());
    await db.insert(scenes).values({
      id: noScriptId,
      sequenceId,
      orderIndex: 1,
      originalScript: null,
    });

    const methods = createSceneScriptVersionsMethods(db);
    const sceneRows = await db
      .select()
      .from(scenes)
      .where(eq(scenes.sequenceId, sequenceId));

    expect(await methods.seedSplitFromSceneRows(sceneRows)).toBe(1);
    expect(await methods.seedSplitFromSceneRows(sceneRows)).toBe(0);

    const versions = await db
      .select()
      .from(sceneScriptVersions)
      .where(eq(sceneScriptVersions.sceneId, sceneId));
    expect(versions).toHaveLength(1);
  });
});
