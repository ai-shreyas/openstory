/**
 * Behavioural tests for the scoped `video_variants` layer (#990) against a real
 * migrated in-memory D1 (libsql), mirroring the `is-stale.test.ts` harness.
 *
 * Pins the append-only version store + selection-as-pointer contract: append
 * (with generating-retry idempotency), list-by-group ordering / discard
 * filtering, `select` (segment pointer + `shots.video*` mirror + `video.selected`
 * event, all atomic), discard/undiscard, and staleness.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Client, createClient } from '@libsql/client';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { generateId } from '@/lib/db/id';
import type { Database } from '@/lib/db/client';
import {
  dbSceneId,
  renderSegments,
  scenes,
  sequenceEvents,
  sequences,
  shots,
  styles,
  teams,
  user,
  videoVariants,
  type NewVideoVariant,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import { createVideoVariantsMethods } from './video-variants';

let client: Client;
let db: Database;
let methods: ReturnType<typeof createVideoVariantsMethods>;

const ACTOR = 'user-1';
let sequenceId = '';
let sceneId = '';
let shotId = '';
let segmentId = '';

async function seed() {
  await db.delete(videoVariants);
  await db.delete(sequenceEvents);
  await db.delete(shots);
  await db.delete(renderSegments);
  await db.delete(scenes);
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);
  await db.delete(user);

  const teamId = generateId();
  sequenceId = generateId();
  sceneId = generateId();
  shotId = generateId();
  segmentId = generateId();

  await db.insert(user).values([{ id: ACTOR, name: 'U', email: 'u@e.com' }]);
  await db.insert(teams).values([{ id: teamId, name: 'T', slug: 't' }]);
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
  if (!style) throw new Error('seed: style insert returned nothing');
  await db
    .insert(sequences)
    .values([{ id: sequenceId, teamId, title: 'S', styleId: style.id }]);
  await db
    .insert(scenes)
    .values([{ id: dbSceneId(sceneId), sequenceId, orderIndex: 0 }]);
  await db
    .insert(renderSegments)
    .values([{ id: segmentId, sceneId, sequenceId }]);
  await db.insert(shots).values([
    {
      id: shotId,
      sequenceId,
      sceneId,
      orderIndex: 0,
      renderSegmentId: segmentId,
    },
  ]);
}

function versionInput(
  overrides: Partial<NewVideoVariant> = {}
): NewVideoVariant {
  return {
    renderSegmentId: segmentId,
    sequenceId,
    model: 'veo3_1',
    manifest: [
      {
        shotId,
        motionPromptVersionId: null,
        frameVersionId: null,
        durationMs: 3000,
      },
    ],
    status: 'completed',
    url: 'https://r2/v.mp4',
    storagePath: 'team/seq/v.mp4',
    inputHash: 'hash-1',
    ...overrides,
  };
}

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
  methods = createVideoVariantsMethods(db);
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await seed();
});

describe('appendVersion', () => {
  it('appends a row and getById round-trips it', async () => {
    const v = await methods.appendVersion(versionInput());
    expect(v.id).toBeTruthy();
    expect(await methods.getById(v.id)).toMatchObject({
      id: v.id,
      renderSegmentId: segmentId,
      model: 'veo3_1',
    });
  });

  it('is idempotent for an in-flight (generating + run id) append', async () => {
    const a = await methods.appendVersion(
      versionInput({ status: 'generating', workflowRunId: 'run-1', url: null })
    );
    const b = await methods.appendVersion(
      versionInput({ status: 'generating', workflowRunId: 'run-1', url: null })
    );
    expect(b.id).toBe(a.id);
  });

  it('a fresh run id appends a distinct generating row', async () => {
    const a = await methods.appendVersion(
      versionInput({ status: 'generating', workflowRunId: 'run-1', url: null })
    );
    const b = await methods.appendVersion(
      versionInput({ status: 'generating', workflowRunId: 'run-2', url: null })
    );
    expect(b.id).not.toBe(a.id);
  });
});

describe('listByGroup', () => {
  it('returns a group oldest-first and excludes discarded by default', async () => {
    // Explicit ascending ids: rapid generateId() calls aren't guaranteed
    // monotonic within a millisecond, but the scoped layer orders by id (ULID ≈
    // creation time), which holds for real seconds-apart appends.
    const a = await methods.appendVersion(versionInput({ id: 'v-001' }));
    const b = await methods.appendVersion(versionInput({ id: 'v-002' }));
    await methods.discard(b.id, { actorId: ACTOR });

    const group = { renderSegmentId: segmentId, model: 'veo3_1' };
    const visible = await methods.listByGroup(group);
    expect(visible.map((v) => v.id)).toEqual([a.id]);

    const all = await methods.listByGroup(group, { includeDiscarded: true });
    expect(all.map((v) => v.id)).toEqual([a.id, b.id]);
  });
});

describe('listBySequence / listModelsForSequence', () => {
  it('lists non-discarded versions and distinct models', async () => {
    await methods.appendVersion(versionInput({ model: 'veo3_1' }));
    await methods.appendVersion(versionInput({ model: 'kling_v3_pro' }));
    const discarded = await methods.appendVersion(versionInput());
    await methods.discard(discarded.id, { actorId: ACTOR });

    expect(await methods.listBySequence(sequenceId)).toHaveLength(2);
    expect((await methods.listModelsForSequence(sequenceId)).sort()).toEqual([
      'kling_v3_pro',
      'veo3_1',
    ]);
  });
});

describe('select', () => {
  it('repoints the segment, mirrors shot video*, and logs the event', async () => {
    const v = await methods.appendVersion(versionInput());
    await methods.select(shotId, v.id, { actorId: ACTOR });

    const [shot] = await db.select().from(shots).where(eq(shots.id, shotId));
    expect(shot?.videoUrl).toBe('https://r2/v.mp4');
    expect(shot?.videoStatus).toBe('completed');
    expect(shot?.motionModel).toBe('veo3_1');

    const [segment] = await db
      .select()
      .from(renderSegments)
      .where(eq(renderSegments.id, segmentId));
    expect(segment?.selectedVideoVersionId).toBe(v.id);

    const [event] = await db
      .select()
      .from(sequenceEvents)
      .where(
        and(
          eq(sequenceEvents.kind, 'video.selected'),
          eq(sequenceEvents.targetId, shotId)
        )
      );
    expect(event).toBeTruthy();
  });

  it('rejects selecting an unfinished version', async () => {
    const v = await methods.appendVersion(
      versionInput({ status: 'generating', url: null })
    );
    await expect(
      methods.select(shotId, v.id, { actorId: ACTOR })
    ).rejects.toThrow(/not 'completed'/);
  });

  it("rejects selecting a version from another shot's segment", async () => {
    const v = await methods.appendVersion(versionInput());
    // A second shot in no/another segment must not select segment 1's version.
    const otherShotId = generateId();
    await db.insert(shots).values([
      {
        id: otherShotId,
        sequenceId,
        sceneId,
        orderIndex: 1,
        renderSegmentId: null,
      },
    ]);
    await expect(
      methods.select(otherShotId, v.id, { actorId: ACTOR })
    ).rejects.toThrow(/belongs to segment/);
  });
});

describe('listSelectedModelsBySequence (#1066)', () => {
  it("maps each shot to its SELECTED version's model, not the latest", async () => {
    const first = await methods.appendVersion(
      versionInput({ id: 'v-001', model: 'veo3_1' })
    );
    // A later render in a different model that was never selected must NOT
    // become the shot's model — resolution follows the pointer, not recency.
    await methods.appendVersion(
      versionInput({ id: 'v-002', model: 'kling_v3_pro' })
    );
    await methods.select(shotId, first.id, { actorId: ACTOR });

    expect([
      ...(await methods.listSelectedModelsBySequence(sequenceId)),
    ]).toEqual([[shotId, 'veo3_1']]);
  });

  it('omits a shot whose segment has no selection', async () => {
    await methods.appendVersion(versionInput());
    expect(await methods.listSelectedModelsBySequence(sequenceId)).toEqual(
      new Map()
    );
  });

  it('omits a shot with no render segment at all', async () => {
    await db.insert(shots).values([
      {
        id: generateId(),
        sequenceId,
        sceneId,
        orderIndex: 1,
        renderSegmentId: null,
      },
    ]);
    const v = await methods.appendVersion(versionInput());
    await methods.select(shotId, v.id, { actorId: ACTOR });

    const selected = await methods.listSelectedModelsBySequence(sequenceId);
    expect(selected.size).toBe(1);
    expect(selected.get(shotId)).toBe('veo3_1');
  });
});

describe('discard / undiscard', () => {
  it('soft-hides and restores a version with matching events', async () => {
    const v = await methods.appendVersion(versionInput());

    await methods.discard(v.id, { actorId: ACTOR });
    expect((await methods.getById(v.id))?.discardedAt).toBeTruthy();

    await methods.undiscard(v.id, { actorId: ACTOR });
    expect((await methods.getById(v.id))?.discardedAt).toBeNull();

    const events = await db
      .select()
      .from(sequenceEvents)
      .where(eq(sequenceEvents.targetId, v.id));
    expect(events.map((e) => e.kind).sort()).toEqual([
      'video.discarded',
      'video.undiscarded',
    ]);
  });
});

describe('isStale', () => {
  it('compares the stored input hash; null stored is never stale', async () => {
    const hashed = await methods.appendVersion(
      versionInput({ inputHash: 'h1' })
    );
    expect(await methods.isStale(hashed.id, 'h1')).toBe(false);
    expect(await methods.isStale(hashed.id, 'h2')).toBe(true);

    const legacy = await methods.appendVersion(
      versionInput({ inputHash: null })
    );
    expect(await methods.isStale(legacy.id, 'anything')).toBe(false);
  });
});
