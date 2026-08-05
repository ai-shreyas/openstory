/**
 * Cloudflare Workflows port of `recastLocationWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/recast-location-workflow.ts`)
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
 *   - The chained `location-sheet` child invocation now uses Pattern 3
 *     (`spawnAndAwaitChild`) against the CF `LocationSheetWorkflow`.
 *   - The chained `regenerate-shots` child invocation is stubbed pending
 *     its own CF port (Wave 3 batch). The `build-regenerate-snapshot` step
 *     lives in `regenerateShotsIfNeeded` for diff parity with the QStash
 *     original; the stub fires immediately after the snapshot step so the
 *     workflow falls back to QStash via the registry switch. */

import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import type { ScopedDb } from '@/lib/db/scoped';
import { getGenerationChannel } from '@/lib/realtime';
import { spawnAndAwaitChild } from '@/lib/workflow/await-child';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import type { CloudflareEnv } from '@/lib/workflow/types';
import type {
  LocationSheetWorkflowInput,
  LocationSheetWorkflowResult,
  RecastLocationWorkflowInput,
  RegenerateShotsWorkflowInput,
} from '@/lib/workflow/types';
import {
  buildRegenerateShotSnapshot,
  computeRegenerateShotsBatchHash,
} from '@/lib/workflows/regenerate-shots-snapshot';
import {
  computeLocationSheetHashFromDto,
  resolveLibraryLocationReferenceHash,
} from '@/lib/workflows/sheet-snapshots';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'recast-location']);

type RecastLocationWorkflowResult = {
  referenceImageUrl: string;
  shotsRegenerated: number;
  shotsFailed: number;
};

/**
 * Build the regenerate-shots snapshot and (eventually) invoke the
 * `regenerate-shots` child. Today the invoke is stubbed inside a `step.do`
 * with a `NonRetryableError` — Pattern 3 will wire up the real child spawn
 * once the CF port of `regenerate-shots-workflow` lands.
 *
 * Lives in its own helper to mirror the QStash original's flow: snapshot
 * building runs as its own step before the child kicks off.
 */
async function regenerateShotsIfNeeded(
  step: WorkflowStep,
  env: CloudflareEnv,
  parentInstanceId: string,
  scopedDb: ScopedDb,
  input: RecastLocationWorkflowInput
): Promise<{ shotsRegenerated: number; shotsFailed: number }> {
  if (input.affectedShotIds.length === 0) {
    return { shotsRegenerated: 0, shotsFailed: 0 };
  }

  const regenerateBody = await step.do(
    'build-regenerate-snapshot',
    async (): Promise<RegenerateShotsWorkflowInput> => {
      const sequenceId = input.sequenceId;
      if (!sequenceId) {
        throw new NonRetryableError(
          '[RecastLocationWorkflow:cf] sequenceId is required to regenerate shots',
          'WorkflowValidationError'
        );
      }
      const imageModel = input.imageModel ?? DEFAULT_IMAGE_MODEL;
      const sequence = await scopedDb.sequences.getById(sequenceId);
      if (!sequence) {
        throw new Error(
          `[RecastLocationWorkflow:cf] Sequence ${sequenceId} not found`
        );
      }
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
          `[RecastLocationWorkflow:cf] Missing shots for ${input.locationName}: ${missing.join(', ')}`
        );
      }
      // The image prompt mirror lives on each shot's anchor frame (#989) —
      // keyed by shotId (NOT id-reuse).
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
        triggerKind: 'location' as const,
        triggerId: input.locationDbId,
        imageModel,
        aspectRatio,
        shotSnapshots,
        snapshotInputHash,
      };
    }
  );

  await spawnAndAwaitChild<RegenerateShotsWorkflowInput, unknown>(step, {
    binding: env.REGENERATE_SHOTS_WORKFLOW,
    parentBindingName: 'RECAST_LOCATION_WORKFLOW',
    parentInstanceId,
    childId: `regenerate-shots:location:${input.locationDbId}`,
    childPayload: regenerateBody,
    spawnStepName: 'spawn-regenerate-shots',
    awaitStepName: 'await-regenerate-shots',
  });

  return {
    shotsRegenerated: input.affectedShotIds.length,
    shotsFailed: 0,
  };
}

export class RecastLocationWorkflow extends OpenStoryWorkflowEntrypoint<RecastLocationWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<RecastLocationWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<RecastLocationWorkflowResult> {
    const input = event.payload;

    logger.info(
      `[RecastLocationWorkflow:cf] Starting recast for ${input.locationName} with ${input.affectedShotIds.length} affected shots`
    );

    // Step 1: Generate new location reference image with library reference.
    // Inline the upstream library-location's reference_input_hash so the
    // child workflow can detect divergence if the library location is
    // regenerated mid-flight.
    const sheetBody = await step.do(
      'build-location-sheet-snapshot',
      async (): Promise<LocationSheetWorkflowInput> => {
        const libraryLocationReferenceHash =
          await resolveLibraryLocationReferenceHash(
            scopedDb,
            input.locationDbId
          );
        const partial: LocationSheetWorkflowInput = {
          locationDbId: input.locationDbId,
          locationName: input.locationName,
          locationMetadata: input.locationMetadata,
          sequenceId: input.sequenceId,
          teamId: input.teamId,
          userId: input.userId,
          imageModel: input.imageModel,
          referenceImageUrl: input.referenceImageUrl,
          libraryLocationDescription: input.libraryLocationDescription,
          styleConfig: input.styleConfig,
          libraryLocationReferenceHash,
        };
        partial.snapshotInputHash =
          await computeLocationSheetHashFromDto(partial);
        return partial;
      }
    );

    const sheetResult = await spawnAndAwaitChild<
      LocationSheetWorkflowInput,
      LocationSheetWorkflowResult
    >(step, {
      binding: this.env.LOCATION_SHEET_WORKFLOW,
      parentBindingName: 'RECAST_LOCATION_WORKFLOW',
      parentInstanceId: event.instanceId,
      childId: `location-sheet:${input.sequenceId ?? 'no-seq'}:${input.locationDbId}`,
      childPayload: sheetBody,
      spawnStepName: 'spawn-location-sheet',
      awaitStepName: 'await-location-sheet',
    });

    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    if (!sheetResult?.referenceImageUrl) {
      throw new Error(
        `Location reference generation failed for ${input.locationName}`
      );
    }

    logger.info(
      `[RecastLocationWorkflow:cf] Location reference generated for ${input.locationName}, regenerating ${input.affectedShotIds.length} shots`
    );

    // Step 2: Regenerate affected shots via Pattern 3 spawn.
    const { shotsRegenerated, shotsFailed } = await regenerateShotsIfNeeded(
      step,
      this.env,
      event.instanceId,
      scopedDb,
      input
    );

    if (input.affectedShotIds.length > 0) {
      logger.info(
        `[RecastLocationWorkflow:cf] Regenerated ${shotsRegenerated} shots for ${input.locationName}`
      );
    }

    return {
      referenceImageUrl: sheetResult.referenceImageUrl,
      shotsRegenerated,
      shotsFailed,
    };
  }

  protected override async onFailure({
    event,
    error,
  }: {
    event: Readonly<WorkflowEvent<RecastLocationWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): Promise<void> {
    const input = event.payload;

    await getGenerationChannel(input.sequenceId).emit(
      'generation.recast-location:failed',
      {
        locationId: input.locationDbId,
        error,
      }
    );

    logger.error(
      `[RecastLocationWorkflow:cf] Recast failed for ${input.locationName}: ${error}`
    );
  }
}
