/**
 * Scoped Characters Sub-module
 * Character CRUD, sheet generation, talent assignment, and shot-character matching.
 */

import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '@/lib/db/client';
import type {
  Character,
  CharacterWithTalent,
  Shot,
  NewCharacter,
  SheetStatus,
} from '@/lib/db/schema';
import { characters, shots, talent } from '@/lib/db/schema';
import {
  loadSceneContextBySequenceFromDb,
  resolveSceneForShot,
} from '@/lib/scenes/scene-script';
import { matchCharacterToShotTags } from '@/lib/workflows/scene-matching';

export function createCharactersMethods(db: Database) {
  // Private update helper used by updateSheetStatus and updateSheet
  const update = async (
    id: string,
    data: Partial<NewCharacter>
  ): Promise<Character> => {
    const [character] = await db
      .update(characters)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(characters.id, id))
      .returning();

    if (!character) {
      throw new Error(`SequenceCharacter ${id} not found`);
    }

    return character;
  };

  return {
    getById: async (id: string): Promise<Character | null> => {
      const result = await db
        .select()
        .from(characters)
        .where(eq(characters.id, id));
      return result[0] ?? null;
    },

    getByCharacterId: async (
      sequenceId: string,
      characterId: string
    ): Promise<Character | null> => {
      const result = await db
        .select()
        .from(characters)
        .where(
          and(
            eq(characters.sequenceId, sequenceId),
            eq(characters.characterId, characterId)
          )
        );
      return result[0] ?? null;
    },

    list: async (sequenceId: string): Promise<Character[]> => {
      return await db
        .select()
        .from(characters)
        .where(eq(characters.sequenceId, sequenceId));
    },

    listWithTalent: async (
      sequenceId: string
    ): Promise<CharacterWithTalent[]> => {
      const results = await db
        .select({
          character: characters,
          talent: {
            id: talent.id,
            name: talent.name,
            imageUrl: talent.imageUrl,
          },
        })
        .from(characters)
        .leftJoin(talent, eq(characters.talentId, talent.id))
        .where(eq(characters.sequenceId, sequenceId));

      return results.map((row) => ({
        ...row.character,
        talent: row.talent?.id ? row.talent : null,
      }));
    },

    getByIds: async (ids: string[]): Promise<Character[]> => {
      if (ids.length === 0) return [];
      return await db
        .select()
        .from(characters)
        .where(inArray(characters.id, ids));
    },

    listWithSheets: async (sequenceId: string): Promise<Character[]> => {
      return await db
        .select()
        .from(characters)
        .where(
          and(
            eq(characters.sequenceId, sequenceId),
            eq(characters.sheetStatus, 'completed')
          )
        );
    },

    create: async (data: NewCharacter): Promise<Character> => {
      const [character] = await db
        .insert(characters)
        .values(data)
        .onConflictDoUpdate({
          target: [characters.sequenceId, characters.characterId],
          set: {
            name: data.name,
            age: data.age,
            gender: data.gender,
            ethnicity: data.ethnicity,
            physicalDescription: data.physicalDescription,
            standardClothing: data.standardClothing,
            distinguishingFeatures: data.distinguishingFeatures,
            consistencyTag: data.consistencyTag,
            sheetImageUrl: data.sheetImageUrl,
            sheetImagePath: data.sheetImagePath,
            sheetStatus: data.sheetStatus,
            sheetGeneratedAt: data.sheetGeneratedAt,
            talentId: data.talentId,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!character) {
        throw new Error(
          `Failed to create Character for sequence ${data.sequenceId} (characterId ${data.characterId})`
        );
      }
      return character;
    },

    createBulk: async (data: NewCharacter[]): Promise<Character[]> => {
      if (data.length === 0) return [];
      const BATCH_SIZE = 4;
      const results: Character[] = [];

      for (let i = 0; i < data.length; i += BATCH_SIZE) {
        const batch = data.slice(i, i + BATCH_SIZE);
        const batchResults = await db
          .insert(characters)
          .values(batch)
          .returning();
        results.push(...batchResults);
      }

      return results;
    },

    update,

    delete: async (id: string): Promise<boolean> => {
      const result = await db.delete(characters).where(eq(characters.id, id));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return (result.rowsAffected ?? 0) > 0;
    },

    deleteBySequence: async (sequenceId: string): Promise<number> => {
      const result = await db
        .delete(characters)
        .where(eq(characters.sequenceId, sequenceId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return result.rowsAffected ?? 0;
    },

    updateSheetStatus: async (
      id: string,
      status: SheetStatus,
      error?: string
    ): Promise<Character> => {
      return await update(id, {
        sheetStatus: status,
        sheetError: error ?? null,
        ...(status === 'completed' && { sheetGeneratedAt: new Date() }),
      });
    },

    updateSheet: async (
      id: string,
      imageUrl: string,
      imagePath: string,
      inputHash: string | null = null
    ): Promise<Character> => {
      return await update(id, {
        sheetImageUrl: imageUrl,
        sheetImagePath: imagePath,
        sheetStatus: 'completed',
        sheetGeneratedAt: new Date(),
        sheetError: null,
        sheetInputHash: inputHash,
      });
    },

    getNeedingSheets: async (sequenceId: string): Promise<Character[]> => {
      return await db
        .select()
        .from(characters)
        .where(
          and(
            eq(characters.sequenceId, sequenceId),
            inArray(characters.sheetStatus, ['pending', 'failed'])
          )
        );
    },

    updateTalent: async (
      characterId: string,
      talentId: string | null
    ): Promise<Character> => {
      const [character] = await db
        .update(characters)
        .set({ talentId, updatedAt: new Date() })
        .where(eq(characters.id, characterId))
        .returning();

      if (!character) {
        throw new Error(`Character ${characterId} not found`);
      }

      return character;
    },

    isStale: async (
      characterId: string,
      currentHash: string
    ): Promise<boolean> => {
      const result = await db
        .select({ hash: characters.sheetInputHash })
        .from(characters)
        .where(eq(characters.id, characterId));
      const row = result[0];
      if (!row) {
        throw new Error(`Character ${characterId} not found`);
      }
      const stored = row.hash;
      if (stored === null) return false;
      return currentHash !== stored;
    },

    getShotsForCharacter: async (
      sequenceId: string,
      characterId: string
    ): Promise<Shot[]> => {
      // Get the character to extract matching patterns
      const charResult = await db
        .select()
        .from(characters)
        .where(eq(characters.id, characterId));
      const character = charResult[0] ?? null;
      if (!character || character.sequenceId !== sequenceId) {
        return [];
      }

      const [allShots, sceneContext] = await Promise.all([
        db
          .select()
          .from(shots)
          .where(eq(shots.sequenceId, sequenceId)) as Promise<Shot[]>,
        loadSceneContextBySequenceFromDb(db, sequenceId),
      ]);

      // Filter shots that contain this character
      return allShots.filter((shot) => {
        const scene = resolveSceneForShot(shot, sceneContext).scene;
        const characterTags = scene?.continuity?.characterTags ?? [];
        return matchCharacterToShotTags(character, characterTags);
      });
    },

    getShotIdsForCharacter: async (
      sequenceId: string,
      characterId: string
    ): Promise<string[]> => {
      // Get the character to extract matching patterns
      const charResult = await db
        .select()
        .from(characters)
        .where(eq(characters.id, characterId));
      const character = charResult[0] ?? null;
      if (!character || character.sequenceId !== sequenceId) {
        return [];
      }

      const [allShots, sceneContext] = await Promise.all([
        db
          .select()
          .from(shots)
          .where(eq(shots.sequenceId, sequenceId)) as Promise<Shot[]>,
        loadSceneContextBySequenceFromDb(db, sequenceId),
      ]);

      // Filter shots that contain this character and return IDs
      return allShots
        .filter((shot) => {
          const scene = resolveSceneForShot(shot, sceneContext).scene;
          const characterTags = scene?.continuity?.characterTags ?? [];
          return matchCharacterToShotTags(character, characterTags);
        })
        .map((f) => f.id);
    },
  };
}
