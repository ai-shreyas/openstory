/**
 * Sequence Characters Server Functions
 * Functions for sequence-specific character (talent) operations
 */

import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

import { safeTextToImageModel } from '@/lib/ai/models';
import { StyleConfigSchema } from '@/lib/db/schema';
import { buildCastingAttributes } from '@/lib/prompts/character-prompt';
import { getGenerationChannel } from '@/lib/realtime';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import type { RecastCharacterWorkflowInput } from '@/lib/workflow/types';
import { buildRecastRegenerateSnapshots } from '@/lib/workflows/recast-snapshot';

import { authWithTeamMiddleware, sequenceAccessMiddleware } from './middleware';

/**
 * Recast accepts talents owned by the requesting team OR public talents.
 * Mirrors the read-side ACL in `talent.getWithRelations`. Extracted for unit
 * testing because this is a permission boundary and silent regressions here
 * would let one team trigger recasts using another team's private talent.
 */
export function assertTalentAccessible(
  talent: { teamId: string; isPublic: boolean | null },
  contextTeamId: string
): void {
  if (talent.teamId !== contextTeamId && !talent.isPublic) {
    throw new Error('Talent does not belong to your team');
  }
}

/** Get all characters for a sequence with their assigned talent */
export const getSequenceCharactersFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.characters.listWithTalent(context.sequence.id);
  });

/** Get shot IDs for all shots containing a specific character */
export const getShotIdsForCharacterFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(z.object({ characterId: z.string().min(1) })))
  .handler(async ({ context, data }) => {
    const shotIds = await context.scopedDb.characters.getShotIdsForCharacter(
      context.sequence.id,
      data.characterId
    );
    return { shotIds, count: shotIds.length };
  });

/** Recast a character with different talent, triggering sheet regeneration */
export const recastCharacterFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(
    zodValidator(
      z.object({ characterId: z.string().min(1), talentId: ulidSchema })
    )
  )
  .handler(async ({ context, data }) => {
    const character = await context.scopedDb.characters.getById(
      data.characterId
    );
    if (!character) {
      throw new Error('Character not found');
    }

    // Fetch the sequence's style for character sheet generation
    const sequence = await context.scopedDb.sequences.getForUser({
      sequenceId: character.sequenceId,
    });
    const style = sequence.styleId
      ? await context.scopedDb.styles.getById(sequence.styleId)
      : null;
    const styleConfig = style
      ? StyleConfigSchema.parse(style.config)
      : undefined;

    const talentWithSheets = await context.scopedDb.talent.getWithRelations(
      data.talentId
    );
    if (!talentWithSheets) {
      throw new Error('Talent not found');
    }
    assertTalentAccessible(talentWithSheets, context.teamId);

    // Filter divergent sheets out of the fallback chain — they are stale-
    // marked variants and must not back the talent's casting identity.
    const defaultSheet =
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      talentWithSheets.sheets?.find((s) => s.isDefault && !s.divergedAt) ??
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      talentWithSheets.sheets?.find((s) => !s.divergedAt);

    // Merge talent appearance with character role attributes
    const castingAttrs = buildCastingAttributes(
      {
        characterId: character.characterId,
        name: character.name,
        age: character.age ?? '',
        gender: character.gender ?? '',
        ethnicity: character.ethnicity ?? '',
        physicalDescription: character.physicalDescription ?? '',
        standardClothing: character.standardClothing ?? '',
        distinguishingFeatures: character.distinguishingFeatures ?? '',
        consistencyTag: character.consistencyTag ?? '',
      },
      {
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
        sheetMetadata: defaultSheet?.metadata ?? undefined,
        talentName: talentWithSheets.name,
        talentDescription: talentWithSheets.description ?? undefined,
      }
    );

    // Update talent assignment AND physical attributes from talent
    await context.scopedDb.characters.updateTalent(
      data.characterId,
      data.talentId
    );
    const updatedCharacter = await context.scopedDb.characters.update(
      data.characterId,
      {
        age: castingAttrs.age,
        gender: castingAttrs.gender,
        ethnicity: castingAttrs.ethnicity,
        physicalDescription: castingAttrs.physicalDescription,
        consistencyTag: castingAttrs.consistencyTag,
      }
    );

    const affectedShotIds =
      await context.scopedDb.characters.getShotIdsForCharacter(
        character.sequenceId,
        data.characterId
      );

    // Always generate a character sheet showing the talent in costume
    await context.scopedDb.characters.updateSheetStatus(
      data.characterId,
      'generating'
    );

    await getGenerationChannel(character.sequenceId).emit(
      'generation.character-sheet:progress',
      { characterId: data.characterId, status: 'generating' }
    );

    // Freeze every regenerate-shots input here, at the trigger. The workflow
    // used to rebuild this after its sheet child finished — eight live reads
    // against state the user never authorised.
    const imageModel = safeTextToImageModel(sequence.imageModel);
    const { shotSnapshots, snapshotInputHash } =
      await buildRecastRegenerateSnapshots({
        scopedDb: context.scopedDb,
        sequenceId: character.sequenceId,
        shotIds: affectedShotIds,
        imageModel,
        aspectRatio: sequence.aspectRatio,
        subject: { kind: 'character', character: updatedCharacter },
      });

    const workflowInput: RecastCharacterWorkflowInput = {
      characterDbId: data.characterId,
      characterName: character.name,
      characterMetadata: {
        characterId: character.characterId,
        name: character.name,
        ...castingAttrs,
      },
      sequenceId: character.sequenceId,
      teamId: context.teamId,
      userId: context.user.id,
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      referenceImageUrl: defaultSheet?.imageUrl ?? undefined,
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      talentMetadata: defaultSheet?.metadata ?? undefined,
      // Image-anchored, name-free (see buildCastingAttributes): naming a
      // person + "look exactly like" trips OpenAI's likeness moderation.
      talentDescription:
        `This character must exactly match the person shown in the reference image. ${talentWithSheets.description ?? ''}`.trim(),
      imageModel,
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      talentSheetInputHash: defaultSheet?.inputHash ?? null,
      styleConfig,
      aspectRatio: sequence.aspectRatio,
      shotSnapshots,
      snapshotInputHash,
    };

    const workflowRunId = await triggerWorkflow(
      '/recast-character',
      workflowInput,
      { label: buildWorkflowLabel(character.sequenceId) }
    );

    return {
      character: updatedCharacter,
      talentId: data.talentId,
      sheetWorkflowRunId: workflowRunId,
      // The shots actually queued — a shot with no selected image prompt is
      // dropped by the snapshot builder rather than failing the recast.
      affectedShotIds: shotSnapshots.map((s) => s.shotId),
    };
  });
