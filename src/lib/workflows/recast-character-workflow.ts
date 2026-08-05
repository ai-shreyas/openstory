/**
 * Cloudflare Workflows port of `recastCharacterWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/recast-character-workflow.ts`)
 * step for step — same step names, same control flow, same side effects.
 * The only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads the workflow run id from `event.instanceId` instead of
 *     `context.workflowRunId` (not needed for this workflow, but listed
 *     here for parity with the other CF ports).
 *   - Calls the snapshot DTO computers directly instead of going through
 *     the `context.snapshot.*` extension.
 *   - The chained `character-sheet` and `regenerate-shots` child invocations
 *     are stubbed out pending Pattern 3 (fan-out helpers) — exercised in a
 *     later batch after all leaves are ported. The `build-regenerate-snapshot`
 *     step lives in `regenerateShotsIfNeeded` for diff parity with the
 *     QStash original; it becomes reachable once the sheet stub is replaced
 *     with a real child spawn. */

import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import type { ScopedDb } from '@/lib/db/scoped';
import { getGenerationChannel } from '@/lib/realtime';
import { spawnAndAwaitChild } from '@/lib/workflow/await-child';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import type { CloudflareEnv } from '@/lib/workflow/types';
import type {
  CharacterSheetWorkflowInput,
  CharacterSheetWorkflowResult,
  RecastCharacterWorkflowInput,
  RegenerateShotsWorkflowInput,
} from '@/lib/workflow/types';
import {
  buildRegenerateShotSnapshot,
  computeRegenerateShotsBatchHash,
} from '@/lib/workflows/regenerate-shots-snapshot';
import {
  computeCharacterSheetHashFromDto,
  resolveTalentSheetHash,
} from '@/lib/workflows/sheet-snapshots';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'recast-character']);

type RecastCharacterWorkflowResult = {
  sheetImageUrl: string;
  shotsRegenerated: number;
  shotsFailed: number;
};

/**
 * Build the regenerate-shots snapshot and (eventually) invoke the
 * `regenerate-shots` child. Today this throws at the invoke site —
 * Pattern 3 will wire up the actual `context.invoke` equivalent.
 *
 * Lives in its own helper to mirror the QStash original's flow: snapshot
 * building runs as its own step before the child kicks off.
 */
async function regenerateShotsIfNeeded(
  step: WorkflowStep,
  env: CloudflareEnv,
  parentInstanceId: string,
  scopedDb: ScopedDb,
  input: RecastCharacterWorkflowInput
): Promise<{ shotsRegenerated: number; shotsFailed: number }> {
  if (input.affectedShotIds.length === 0) {
    return { shotsRegenerated: 0, shotsFailed: 0 };
  }

  // The actual payload is rebuilt inside the spawn step from the previous
  // step's output. CF persists the previous step.do return, so we read it
  // back from a separate step.do that wraps the snapshot construction —
  // but here we keep it inline because the `build-regenerate-snapshot`
  // step above already computed everything we need.
  await spawnAndAwaitChild<RegenerateShotsWorkflowInput, unknown>(step, {
    binding: env.REGENERATE_SHOTS_WORKFLOW,
    parentBindingName: 'RECAST_CHARACTER_WORKFLOW',
    parentInstanceId,
    childId: `regenerate-shots:character:${input.characterDbId}`,
    childPayload: await step.do('snapshot-payload-for-regenerate', () =>
      buildRegeneratePayload(scopedDb, input)
    ),
    spawnStepName: 'spawn-regenerate-shots',
    awaitStepName: 'await-regenerate-shots',
  });
  return {
    shotsRegenerated: input.affectedShotIds.length,
    shotsFailed: 0,
  };
}

async function buildRegeneratePayload(
  scopedDb: ScopedDb,
  input: RecastCharacterWorkflowInput
): Promise<RegenerateShotsWorkflowInput> {
  const sequenceId = input.sequenceId;
  if (!sequenceId) {
    throw new NonRetryableError(
      '[RecastCharacterWorkflow:cf] sequenceId is required to regenerate shots',
      'WorkflowValidationError'
    );
  }
  const sequence = await scopedDb.sequences.getById(sequenceId);
  if (!sequence) {
    throw new Error(
      `[RecastCharacterWorkflow:cf] Sequence ${sequenceId} not found`
    );
  }
  const imageModel = input.imageModel ?? DEFAULT_IMAGE_MODEL;
  const [characters, locations, elements, shots] = await Promise.all([
    scopedDb.characters.listWithSheets(sequenceId),
    scopedDb.sequenceLocations.listWithReferences(sequenceId),
    scopedDb.sequenceElements.list(sequenceId),
    scopedDb.shots.getByIds(input.affectedShotIds),
  ]);
  if (shots.length !== input.affectedShotIds.length) {
    const found = new Set(shots.map((f) => f.id));
    const missing = input.affectedShotIds.filter((id) => !found.has(id));
    throw new Error(
      `[RecastCharacterWorkflow:cf] Missing shots for ${input.characterName}: ${missing.join(', ')}`
    );
  }
  // The image prompt mirror lives on each shot's anchor frame (#989) — keyed by
  // shotId (NOT id-reuse).
  const framesByShot = await scopedDb.frames.getAnchorsByShots(
    shots.map((s) => s.id)
  );
  const aspectRatio = sequence.aspectRatio;
  const shotSnapshots = await Promise.all(
    shots.map((shot) =>
      buildRegenerateShotSnapshot({
        shot,
        imagePrompt: framesByShot.get(shot.id)?.imagePrompt ?? null,
        characters,
        locations,
        elements,
        imageModel,
        aspectRatio,
      })
    )
  );
  const partial = { sequenceId, imageModel, aspectRatio, shotSnapshots };
  const snapshotInputHash = await computeRegenerateShotsBatchHash(partial);
  return {
    userId: input.userId,
    teamId: input.teamId,
    sequenceId,
    shotIds: input.affectedShotIds,
    triggerKind: 'character' as const,
    triggerId: input.characterDbId,
    imageModel,
    aspectRatio,
    shotSnapshots,
    snapshotInputHash,
  };
}

export class RecastCharacterWorkflow extends OpenStoryWorkflowEntrypoint<RecastCharacterWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<RecastCharacterWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<RecastCharacterWorkflowResult> {
    const input = event.payload;

    // Step 1: Build the character-sheet payload (resolve upstream talent-sheet
    // hash + snapshot hash). Captured into a const so the spawn below reuses
    // the cached step result on replay instead of recomputing.
    const sheetPayload = await step.do(
      'build-character-sheet-snapshot',
      async (): Promise<CharacterSheetWorkflowInput> => {
        logger.info(
          `[RecastCharacterWorkflow:cf] Starting recast for ${input.characterName} with ${input.affectedShotIds.length} affected shots`
        );
        const talentSheetInputHash = await resolveTalentSheetHash(
          scopedDb,
          input.characterDbId
        );
        const partial: CharacterSheetWorkflowInput = {
          characterDbId: input.characterDbId,
          characterName: input.characterName,
          characterMetadata: input.characterMetadata,
          sequenceId: input.sequenceId,
          teamId: input.teamId,
          userId: input.userId,
          imageModel: input.imageModel,
          referenceImageUrl: input.referenceImageUrl,
          talentMetadata: input.talentMetadata,
          talentDescription: input.talentDescription,
          styleConfig: input.styleConfig,
          talentSheetInputHash,
        };
        partial.snapshotInputHash =
          await computeCharacterSheetHashFromDto(partial);
        return partial;
      }
    );

    const sheetResult = await spawnAndAwaitChild<
      CharacterSheetWorkflowInput,
      CharacterSheetWorkflowResult
    >(step, {
      binding: this.env.CHARACTER_SHEET_WORKFLOW,
      parentBindingName: 'RECAST_CHARACTER_WORKFLOW',
      parentInstanceId: event.instanceId,
      childId: `character-sheet:recast:${input.characterDbId}`,
      childPayload: sheetPayload,
      spawnStepName: 'spawn-character-sheet',
      awaitStepName: 'await-character-sheet',
    });

    const sheetImageUrl = sheetResult.sheetImageUrl;
    const { shotsRegenerated, shotsFailed } = await regenerateShotsIfNeeded(
      step,
      this.env,
      event.instanceId,
      scopedDb,
      input
    );

    return { sheetImageUrl, shotsRegenerated, shotsFailed };
  }

  protected override async onFailure({
    event,
    error,
  }: {
    event: Readonly<WorkflowEvent<RecastCharacterWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): Promise<void> {
    const input = event.payload;

    await getGenerationChannel(input.sequenceId).emit(
      'generation.recast:failed',
      {
        characterId: input.characterDbId,
        error,
      }
    );

    logger.error(
      `[RecastCharacterWorkflow:cf] Recast failed for ${input.characterName}: ${error}`
    );
  }
}
