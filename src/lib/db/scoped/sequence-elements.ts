/**
 * Scoped Sequence Elements Sub-module
 * Element CRUD for per-sequence uploaded reference images.
 */

import type { Database } from '@/lib/db/client';
import type {
  ElementVisionStatus,
  Shot,
  NewSequenceElement,
  SequenceElement,
} from '@/lib/db/schema';
import {
  frames,
  scenes,
  sceneScriptVersions,
  shots,
  shotPromptVersions,
  sequenceElements,
  sequences,
} from '@/lib/db/schema';
import {
  buildShotRenameDeltas,
  replaceTokenInText,
} from '@/lib/sequence-elements/cascade-rename';
import {
  enrichShotWithSceneScript,
  loadSelectedScriptsBySequenceFromDb,
  scriptExtract,
} from '@/lib/scenes/scene-script';
import { matchElementsToScene } from '@/lib/workflows/scene-matching';
import { and, eq, inArray, like, ne, or, sql } from 'drizzle-orm';

export function createSequenceElementsMethods(db: Database) {
  const update = async (
    id: string,
    data: Partial<NewSequenceElement>
  ): Promise<SequenceElement> => {
    const [element] = await db
      .update(sequenceElements)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(sequenceElements.id, id))
      .returning();

    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: DB may return undefined
    if (!element) {
      throw new Error(`SequenceElement ${id} not found`);
    }

    return element;
  };

  const getByToken = async (
    sequenceId: string,
    token: string
  ): Promise<SequenceElement | null> => {
    const result = await db
      .select()
      .from(sequenceElements)
      .where(
        and(
          eq(sequenceElements.sequenceId, sequenceId),
          eq(sequenceElements.token, token)
        )
      );
    return result[0] ?? null;
  };

  return {
    getById: async (id: string): Promise<SequenceElement | null> => {
      const result = await db
        .select()
        .from(sequenceElements)
        .where(eq(sequenceElements.id, id));
      return result[0] ?? null;
    },

    getByToken,

    /**
     * Throws if `token` is already taken by another element in this sequence.
     * Use for user-driven renames where collisions must be surfaced; for
     * system-driven renames (vision auto-suggest), use ensureUniqueToken
     * which suffixes a `_N` instead.
     */
    isTokenTaken: async (
      sequenceId: string,
      token: string,
      excludeElementId?: string
    ): Promise<boolean> => {
      const whereClauses = [
        eq(sequenceElements.sequenceId, sequenceId),
        eq(sequenceElements.token, token),
      ];
      if (excludeElementId) {
        whereClauses.push(ne(sequenceElements.id, excludeElementId));
      }
      const rows = await db
        .select({ id: sequenceElements.id })
        .from(sequenceElements)
        .where(and(...whereClauses));
      return rows.length > 0;
    },

    /**
     * Pass `excludeElementId` when the token is being assigned to an existing
     * element (e.g. the vision auto-rename) — otherwise the element's own row
     * counts as a collision and a workflow-step retry after a successful
     * rename suffixes the token to `TOKEN_2`.
     */
    ensureUniqueToken: async (
      sequenceId: string,
      token: string,
      excludeElementId?: string
    ): Promise<string> => {
      // Escape LIKE wildcards (%, _, \) so `foo_bar` doesn't match `foo1bar`.
      const escaped = token.replace(/[\\%_]/g, (c) => `\\${c}`);
      const whereClauses = [
        eq(sequenceElements.sequenceId, sequenceId),
        or(
          eq(sequenceElements.token, token),
          like(sequenceElements.token, sql`${`${escaped}\\_%`} ESCAPE '\\'`)
        ),
      ];
      if (excludeElementId) {
        whereClauses.push(ne(sequenceElements.id, excludeElementId));
      }
      const rows = await db
        .select({ token: sequenceElements.token })
        .from(sequenceElements)
        .where(and(...whereClauses));

      const taken = new Set(rows.map((r) => r.token));
      if (!taken.has(token)) return token;

      // Hard cap — 100 is well above any realistic upload-of-same-name count
      // and bounds the worst-case query path.
      for (let suffix = 2; suffix <= 100; suffix += 1) {
        const candidate = `${token}_${suffix}`;
        if (!taken.has(candidate)) return candidate;
      }
      throw new Error('Unable to generate unique element token');
    },

    list: async (sequenceId: string): Promise<SequenceElement[]> => {
      return await db
        .select()
        .from(sequenceElements)
        .where(eq(sequenceElements.sequenceId, sequenceId))
        .orderBy(sequenceElements.createdAt);
    },

    listByIds: async (ids: string[]): Promise<SequenceElement[]> => {
      if (ids.length === 0) return [];
      return await db
        .select()
        .from(sequenceElements)
        .where(inArray(sequenceElements.id, ids));
    },

    create: async (data: NewSequenceElement): Promise<SequenceElement> => {
      const [element] = await db
        .insert(sequenceElements)
        .values(data)
        .returning();
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB may return undefined
      if (!element) {
        throw new Error('Failed to insert sequence element');
      }
      return element;
    },

    update,

    updateVisionStatus: async (
      id: string,
      status: ElementVisionStatus,
      error?: string
    ): Promise<SequenceElement> => {
      return await update(id, {
        visionStatus: status,
        visionError: error ?? null,
        ...(status === 'completed' && { visionGeneratedAt: new Date() }),
      });
    },

    updateVisionResult: async (
      id: string,
      description: string,
      consistencyTag: string
    ): Promise<SequenceElement> => {
      return await update(id, {
        description,
        consistencyTag,
        visionStatus: 'completed',
        visionGeneratedAt: new Date(),
        visionError: null,
      });
    },

    updateFirstMention: async (
      id: string,
      firstMention: {
        sceneId: string;
        text: string;
        lineNumber: number;
      }
    ): Promise<SequenceElement> => {
      return await update(id, {
        firstMentionSceneId: firstMention.sceneId,
        firstMentionText: firstMention.text,
        firstMentionLine: firstMention.lineNumber,
      });
    },

    /**
     * Rename an element's token and rewrite every reference to the old token
     * across the sequence: `sequences.script`, per-shot `metadata` (continuity
     * tags, originalScript extract, prompt strings) and the user-edit
     * `imagePrompt`/`motionPrompt` overrides on `shots`.
     *
     * All writes (element row, script, shot deltas) run in a single
     * `db.batch()` — one transaction — so a mid-cascade failure can't leave
     * mixed token references (and a workflow-step retry then renaming the
     * remainder to `TOKEN_2`, splitting element/script/frames).
     *
     * Returns the affected counts so callers can surface a meaningful toast
     * ("Renamed LOGO → BRAND across 5 shots + script"). The caller is
     * expected to have already validated uniqueness of `newToken` within the
     * sequence — this method does not check collisions.
     */
    cascadeRename: async (args: {
      sequenceId: string;
      elementId: string;
      oldToken: string;
      newToken: string;
    }): Promise<{
      element: SequenceElement;
      shotsUpdated: number;
      scriptUpdated: boolean;
    }> => {
      const { sequenceId, elementId, oldToken, newToken } = args;

      if (oldToken === newToken) {
        const element = await update(elementId, { token: newToken });
        return { element, shotsUpdated: 0, scriptUpdated: false };
      }

      const now = new Date();
      const elementUpdate = db
        .update(sequenceElements)
        .set({ token: newToken, updatedAt: now })
        .where(eq(sequenceElements.id, elementId))
        .returning();

      const [sequenceRow] = await db
        .select({ script: sequences.script })
        .from(sequences)
        .where(eq(sequences.id, sequenceId));
      let rewrittenScript: string | null = null;
      if (sequenceRow?.script) {
        const rewritten = replaceTokenInText(
          sequenceRow.script,
          oldToken,
          newToken
        );
        if (rewritten !== sequenceRow.script) {
          rewrittenScript = rewritten;
        }
      }
      const scriptUpdated = rewrittenScript !== null;
      const scriptStatements =
        rewrittenScript === null
          ? []
          : [
              db
                .update(sequences)
                .set({ script: rewrittenScript, updatedAt: now })
                .where(eq(sequences.id, sequenceId)),
            ];

      const [allShotsRaw, scriptBySceneId] = await Promise.all([
        db
          .select()
          .from(shots)
          .where(eq(shots.sequenceId, sequenceId)) as Promise<Shot[]>,
        loadSelectedScriptsBySequenceFromDb(db, sequenceId),
      ]);
      const allShots = allShotsRaw.map((shot) =>
        enrichShotWithSceneScript(shot, scriptBySceneId)
      );
      // The image prompt lives on each shot's anchor frame now (#989) — keyed
      // by shotId (orderIndex 0), never by id-reuse.
      const frameRows = await db
        .select({ shotId: frames.shotId, imagePrompt: frames.imagePrompt })
        .from(frames)
        .where(
          and(eq(frames.sequenceId, sequenceId), eq(frames.orderIndex, 0))
        );
      const imagePromptByShot = new Map(
        frameRows.map((f) => [f.shotId, f.imagePrompt])
      );
      const shotsWithImagePrompt = allShots.map((s) => ({
        ...s,
        imagePrompt: imagePromptByShot.get(s.id) ?? null,
      }));
      const deltas = buildShotRenameDeltas(
        shotsWithImagePrompt,
        oldToken,
        newToken
      );
      // metadata/motionPrompt → shots; imagePrompt mirror → the anchor frame.
      // The motion prompt is resolved from the *selected* `shot_prompt_versions`
      // row now (#713), so a rename must rewrite that row's text too — updating
      // only the `shot.motionPrompt` mirror would leave the render reading the
      // un-renamed version. (Image resolution reads the `frame.imagePrompt`
      // mirror directly, so the frame update below suffices there.)
      const selectedMotionVersionByShot = new Map(
        allShots.map((s) => [s.id, s.selectedMotionPromptVersionId])
      );
      const selectedScriptRows = await db
        .select({ version: sceneScriptVersions })
        .from(scenes)
        .innerJoin(
          sceneScriptVersions,
          eq(scenes.selectedScriptVersionId, sceneScriptVersions.id)
        )
        .where(eq(scenes.sequenceId, sequenceId));
      const sceneScriptStatements = selectedScriptRows.flatMap(
        ({ version }) => {
          const extract = version.content.extract;
          if (!extract) return [];
          const rewritten = replaceTokenInText(extract, oldToken, newToken);
          if (rewritten === extract) return [];
          return [
            db
              .update(sceneScriptVersions)
              .set({
                content: { ...version.content, extract: rewritten },
              })
              .where(eq(sceneScriptVersions.id, version.id)),
          ];
        }
      );

      const shotStatements = deltas.flatMap((delta) => {
        const set: Record<string, unknown> = { updatedAt: now };
        if (delta.metadata !== undefined) set.metadata = delta.metadata;
        if (delta.motionPrompt !== undefined)
          set.motionPrompt = delta.motionPrompt;
        const selectedMotionVersionId = selectedMotionVersionByShot.get(
          delta.shotId
        );
        return [
          ...(Object.keys(set).length > 1
            ? [db.update(shots).set(set).where(eq(shots.id, delta.shotId))]
            : []),
          ...(delta.motionPrompt !== undefined && selectedMotionVersionId
            ? [
                db
                  .update(shotPromptVersions)
                  .set({ text: delta.motionPrompt })
                  .where(eq(shotPromptVersions.id, selectedMotionVersionId)),
              ]
            : []),
          ...(delta.imagePrompt !== undefined
            ? [
                db
                  .update(frames)
                  .set({ imagePrompt: delta.imagePrompt, updatedAt: now })
                  .where(eq(frames.id, delta.shotId)),
              ]
            : []),
        ];
      });

      const [elementRows] = await db.batch([
        elementUpdate,
        ...scriptStatements,
        ...sceneScriptStatements,
        ...shotStatements,
      ]);
      const element = elementRows[0];
      if (!element) {
        throw new Error(`SequenceElement ${elementId} not found`);
      }

      return { element, shotsUpdated: deltas.length, scriptUpdated };
    },

    delete: async (id: string): Promise<boolean> => {
      const result = await db
        .delete(sequenceElements)
        .where(eq(sequenceElements.id, id));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined
      return (result.rowsAffected ?? 0) > 0;
    },

    getShotIdsForElement: async (
      sequenceId: string,
      elementId: string
    ): Promise<string[]> => {
      const elementResult = await db
        .select()
        .from(sequenceElements)
        .where(eq(sequenceElements.id, elementId));
      const element = elementResult[0] ?? null;
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: DB query may return undefined
      if (!element || element.sequenceId !== sequenceId) {
        return [];
      }

      const [allShotsRaw, scriptBySceneId] = await Promise.all([
        db
          .select()
          .from(shots)
          .where(eq(shots.sequenceId, sequenceId)) as Promise<Shot[]>,
        loadSelectedScriptsBySequenceFromDb(db, sequenceId),
      ]);

      return allShotsRaw
        .map((shot) => enrichShotWithSceneScript(shot, scriptBySceneId))
        .filter((shot) => {
          const elementTags = shot.metadata?.continuity?.elementTags ?? [];
          const sceneScript = scriptExtract(shot.metadata?.originalScript);
          return (
            matchElementsToScene([element], elementTags, sceneScript).length > 0
          );
        })
        .map((f) => f.id);
    },

    /**
     * Shot counts for *all* elements in a sequence, computed in a single
     * scan over shots + elements. The elements grid renders N cards, each
     * of which previously called `getShotIdsForElement` — an N+1 over the
     * full shot set. Returns an `elementId → count` map; elements with zero
     * matches are pre-seeded so the grid can render `Used in 0 shots`
     * instead of `undefined`.
     */
    getShotCountsByElement: async (
      sequenceId: string
    ): Promise<Record<string, { shotCount: number; videoCount: number }>> => {
      const allElements = await db
        .select()
        .from(sequenceElements)
        .where(eq(sequenceElements.sequenceId, sequenceId));
      const counts: Record<string, { shotCount: number; videoCount: number }> =
        {};
      for (const el of allElements) {
        counts[el.id] = { shotCount: 0, videoCount: 0 };
      }
      if (allElements.length === 0) return counts;

      const [allShotsRaw, scriptBySceneId] = await Promise.all([
        db
          .select()
          .from(shots)
          .where(eq(shots.sequenceId, sequenceId)) as Promise<Shot[]>,
        loadSelectedScriptsBySequenceFromDb(db, sequenceId),
      ]);

      for (const rawShot of allShotsRaw) {
        const shot = enrichShotWithSceneScript(rawShot, scriptBySceneId);
        const elementTags = shot.metadata?.continuity?.elementTags ?? [];
        const sceneScript = scriptExtract(shot.metadata?.originalScript);
        const matched = matchElementsToScene(
          allElements,
          elementTags,
          sceneScript
        );
        const hasVideo = !!shot.videoUrl;
        for (const el of matched) {
          const entry = counts[el.id];
          if (!entry) continue;
          entry.shotCount += 1;
          if (hasVideo) entry.videoCount += 1;
        }
      }
      return counts;
    },
  };
}
