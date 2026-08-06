/**
 * In-memory DB tests for the sequence-elements scoped module.
 *
 * getShotCountsByElement — pins the two invariants the elements grid relies on:
 *   - Elements with zero matching shots appear in the result map with `0`
 *     (otherwise the badge reads `undefined`).
 *   - A shot that references N elements increments every matched element's
 *     count (no first-match short-circuit).
 *
 * ensureUniqueToken / cascadeRename — pins the workflow-retry idempotency of
 * the ElementVisionWorkflow auto-rename (issue #846 RC5): the element's own
 * row must not count as a collision, and the cascade must be atomic so a
 * replay yields zero deltas instead of split-brained `TOKEN_2` references.
 */

import { type Client, createClient } from '@libsql/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import type { Database } from '@/lib/db/client';
import { generateId } from '@/lib/db/id';
import {
  dbSceneId,
  scenes,
  shotPromptVersions,
  shots,
  sequenceElements,
  sequences,
  styles,
  teams,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import { createSequenceElementsMethods } from './sequence-elements';

let client: Client;
let db: Database;
let teamId = '';
let sequenceId = '';

async function seed() {
  await db.delete(shots);
  await db.delete(scenes);
  await db.delete(sequenceElements);
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
  await db.insert(sequences).values({
    id: sequenceId,
    teamId,
    title: 'S',
    styleId: style.id,
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
  await seed();
});

/** Continuity + script live on `scenes` (#1067); shots point at them. */
async function insertSceneWithShot(args: {
  orderIndex: number;
  elementTags: string[];
  extract: string;
  motionPrompt?: string;
}) {
  const [scene] = await db
    .insert(scenes)
    .values({
      id: dbSceneId(generateId()),
      sequenceId,
      orderIndex: args.orderIndex,
      originalScript: { extract: args.extract, dialogue: [] },
      continuity: {
        environmentTag: '',
        characterTags: [],
        elementTags: args.elementTags,
        colorPalette: '',
        lightingSetup: '',
        styleTag: '',
      },
    })
    .returning();
  if (!scene) throw new Error('test setup: scene insert returned nothing');
  const [shot] = await db
    .insert(shots)
    .values({
      sequenceId,
      sceneId: scene.id,
      shotNumber: 1,
    })
    .returning();
  if (!shot) throw new Error('test setup: shot insert returned nothing');
  // The motion prompt IS the shot's selected `shot_prompt_versions` row (#713).
  if (args.motionPrompt) {
    const [version] = await db
      .insert(shotPromptVersions)
      .values({
        shotId: shot.id,
        promptType: 'motion',
        text: args.motionPrompt,
        source: 'ai-generated',
      })
      .returning();
    if (!version)
      throw new Error('test setup: version insert returned nothing');
    await db
      .update(shots)
      .set({ selectedMotionPromptVersionId: version.id })
      .where(eq(shots.id, shot.id));
  }
  return scene;
}

describe('getShotCountsByElement', () => {
  it('returns an empty object when no elements exist', async () => {
    const methods = createSequenceElementsMethods(db);
    const result = await methods.getShotCountsByElement(sequenceId);
    expect(result).toEqual({});
  });

  it('seeds a zero entry for every element, even those with no matching shots', async () => {
    const methods = createSequenceElementsMethods(db);

    const [unused] = await db
      .insert(sequenceElements)
      .values({
        sequenceId,
        uploadedFilename: 'unused.png',
        token: 'UNUSED',
        imageUrl: 'https://r2/unused.png',
        imagePath: 'elements/x/unused.png',
      })
      .returning();
    if (!unused) throw new Error('test setup: element insert returned nothing');

    const result = await methods.getShotCountsByElement(sequenceId);
    expect(result[unused.id]?.shotCount).toBe(0);
    expect(result[unused.id]?.videoCount).toBe(0);
  });

  it('counts a shot against every matched element (multi-tag shot increments each)', async () => {
    const methods = createSequenceElementsMethods(db);

    const [logo] = await db
      .insert(sequenceElements)
      .values({
        sequenceId,
        uploadedFilename: 'logo.png',
        token: 'LOGO',
        imageUrl: 'https://r2/logo.png',
        imagePath: 'elements/x/logo.png',
      })
      .returning();
    const [bottle] = await db
      .insert(sequenceElements)
      .values({
        sequenceId,
        uploadedFilename: 'bottle.png',
        token: 'BOTTLE',
        imageUrl: 'https://r2/bottle.png',
        imagePath: 'elements/x/bottle.png',
      })
      .returning();
    const [orphan] = await db
      .insert(sequenceElements)
      .values({
        sequenceId,
        uploadedFilename: 'orphan.png',
        token: 'ORPHAN',
        imageUrl: 'https://r2/orphan.png',
        imagePath: 'elements/x/orphan.png',
      })
      .returning();
    if (!logo || !bottle || !orphan) {
      throw new Error('test setup: element insert returned nothing');
    }

    // Shot referencing both LOGO and BOTTLE via continuity.elementTags.
    await insertSceneWithShot({
      orderIndex: 0,
      elementTags: ['LOGO', 'BOTTLE'],
      extract: 'scene script',
    });

    // Shot referencing only LOGO via script-text fallback (no elementTags).
    await insertSceneWithShot({
      orderIndex: 1,
      elementTags: [],
      extract: 'The LOGO appears on screen.',
    });

    const result = await methods.getShotCountsByElement(sequenceId);
    expect(result[logo.id]?.shotCount).toBe(2);
    expect(result[bottle.id]?.shotCount).toBe(1);
    expect(result[orphan.id]?.shotCount).toBe(0);
  });
});

async function insertElement(token: string) {
  const [element] = await db
    .insert(sequenceElements)
    .values({
      sequenceId,
      uploadedFilename: `${token.toLowerCase()}.png`,
      token,
      imageUrl: `https://r2/${token.toLowerCase()}.png`,
      imagePath: `elements/x/${token.toLowerCase()}.png`,
    })
    .returning();
  if (!element) throw new Error('test setup: element insert returned nothing');
  return element;
}

describe('ensureUniqueToken', () => {
  it('does not count the excluded element’s own row as a collision', async () => {
    const methods = createSequenceElementsMethods(db);
    const element = await insertElement('PROP');

    // Without exclusion the element's own row collides → suffix (the
    // pre-#846 retry bug). With exclusion the token comes back unchanged.
    await expect(methods.ensureUniqueToken(sequenceId, 'PROP')).resolves.toBe(
      'PROP_2'
    );
    await expect(
      methods.ensureUniqueToken(sequenceId, 'PROP', element.id)
    ).resolves.toBe('PROP');
  });

  it('still suffixes when a different element holds the token', async () => {
    const methods = createSequenceElementsMethods(db);
    await insertElement('PROP');
    const other = await insertElement('OTHER');

    await expect(
      methods.ensureUniqueToken(sequenceId, 'PROP', other.id)
    ).resolves.toBe('PROP_2');
  });
});

describe('cascadeRename', () => {
  it('rewrites element + script + shots, and a replay yields zero deltas', async () => {
    const methods = createSequenceElementsMethods(db);
    const element = await insertElement('LOGO');

    await db
      .update(sequences)
      .set({ script: 'The LOGO appears. Pan across the LOGO.' })
      .where(eq(sequences.id, sequenceId));

    const taggedScene = await insertSceneWithShot({
      orderIndex: 0,
      elementTags: ['LOGO'],
      extract: 'The LOGO appears on screen.',
      motionPrompt: 'Push in on the LOGO.',
    });
    await insertSceneWithShot({
      orderIndex: 1,
      elementTags: [],
      extract: 'No element here.',
    });

    const first = await methods.cascadeRename({
      sequenceId,
      elementId: element.id,
      oldToken: 'LOGO',
      newToken: 'BRAND',
    });
    expect(first.element.token).toBe('BRAND');
    expect(first.scriptUpdated).toBe(true);
    expect(first.shotsUpdated).toBe(1);

    const [seq] = await db
      .select({ script: sequences.script })
      .from(sequences)
      .where(eq(sequences.id, sequenceId));
    expect(seq?.script).toBe('The BRAND appears. Pan across the BRAND.');

    const [renamedScene] = await db
      .select({ continuity: scenes.continuity })
      .from(scenes)
      .where(eq(scenes.id, taggedScene.id));
    expect(renamedScene?.continuity?.elementTags).toEqual(['BRAND']);

    const [renamedVersion] = await db
      .select({ text: shotPromptVersions.text })
      .from(shots)
      .innerJoin(
        shotPromptVersions,
        eq(shots.selectedMotionPromptVersionId, shotPromptVersions.id)
      )
      .where(eq(shots.sceneId, taggedScene.id));
    expect(renamedVersion?.text).toBe('Push in on the BRAND.');

    // Workflow-step replay: the cached pre-rename token is the oldToken.
    // Everything already carries BRAND, so the cascade must be a no-op.
    const replay = await methods.cascadeRename({
      sequenceId,
      elementId: element.id,
      oldToken: 'LOGO',
      newToken: 'BRAND',
    });
    expect(replay.element.token).toBe('BRAND');
    expect(replay.scriptUpdated).toBe(false);
    expect(replay.shotsUpdated).toBe(0);
  });

  it('short-circuits when oldToken === newToken', async () => {
    const methods = createSequenceElementsMethods(db);
    const element = await insertElement('LOGO');

    const result = await methods.cascadeRename({
      sequenceId,
      elementId: element.id,
      oldToken: 'LOGO',
      newToken: 'LOGO',
    });
    expect(result.element.token).toBe('LOGO');
    expect(result.shotsUpdated).toBe(0);
    expect(result.scriptUpdated).toBe(false);
  });
});
