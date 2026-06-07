/**
 * Cloudflare Workflows port of `characterSheetWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/character-sheet-workflow.ts`)
 * step for step — same step names, same control flow, same side effects. The
 * only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads the workflow run id from `event.instanceId` instead of
 *     `context.workflowRunId`.
 *   - Calls the snapshot DTO computers directly instead of going through
 *     the `context.snapshot.*` extension. */

import {
  CONTENT_REJECTION_EVENT,
  CONTENT_REJECTION_RETRY_EVENT,
  isContentRejectionError,
} from '@/lib/ai/content-rejection';
import { extractFalErrorMessage } from '@/lib/ai/fal-error';
import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import {
  deductWorkflowCredits,
  extractImageCost,
} from '@/lib/billing/workflow-deduction';
import { generateId } from '@/lib/db/id';
import type { ScopedDb } from '@/lib/db/scoped';
import {
  generateImageWithProvider,
  type ImageGenerationParams,
  type ImageGenerationResult,
} from '@/lib/image/image-generation';
import { buildCharacterSheetPrompt } from '@/lib/prompts/character-prompt';
import { getGenerationChannel } from '@/lib/realtime';
import { STORAGE_BUCKETS } from '@/lib/storage/buckets';
import { uploadResponse } from '@/lib/storage/upload-response';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type {
  CharacterSheetWorkflowInput,
  CharacterSheetWorkflowResult,
} from '@/lib/workflow/types';
import {
  decideSheetDivergence,
  saveDivergentCharacterSheet,
} from '@/lib/workflows/sheet-divergence';
import {
  computeCharacterSheetHashCurrent,
  computeCharacterSheetHashFromDto,
} from '@/lib/workflows/sheet-snapshots';
import { NonRetryableError } from 'cloudflare:workflows';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'character-sheet']);

/**
 * Total sheet generation attempts on a content-flag rejection (#881/#939): the
 * initial attempt plus 2 reseeded re-rolls. `generateImageWithProvider` is
 * called without a fixed seed, so each attempt is naturally reseeded; the
 * stochastic content-checker hits clear on a re-roll, while deterministic ones
 * exhaust this budget and fail hard (a character with no reference sheet can't
 * anchor identity across cuts, so we stop rather than continue unanchored).
 */
const MAX_SHEET_ATTEMPTS = 3;

export class CharacterSheetWorkflow extends OpenStoryWorkflowEntrypoint<CharacterSheetWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<CharacterSheetWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<CharacterSheetWorkflowResult> {
    const input = event.payload;
    const workflowRunId = event.instanceId;

    // Validate snapshot hash inside the workflow body. Matches QStash parity:
    // tampered payloads must halt the run from inside a step, not silently.
    await step.do('validate-snapshot', async () => {
      if (input.snapshotInputHash) {
        const expected = input.snapshotInputHash;
        const recomputed = await computeCharacterSheetHashFromDto(input);
        if (recomputed !== expected) {
          throw new WorkflowValidationError(
            'snapshotInputHash does not match the inlined DTO; payload was tampered with or serialized inconsistently'
          );
        }
      }
    });

    // Emit realtime event that generation has started
    await step.do('emit-start-event', async () => {
      if (input.sequenceId && input.characterDbId) {
        await getGenerationChannel(input.sequenceId).emit(
          'generation.character-sheet:progress',
          {
            characterId: input.characterDbId,
            status: 'generating',
          }
        );
      }
    });

    // Step 1: Validate and build prompt
    const generationParams: ImageGenerationParams = await step.do(
      'build-prompt',
      async () => {
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
        if (!input.characterMetadata) {
          throw new WorkflowValidationError('characterMetadata is required');
        }

        const hasTalent = !!(input.talentMetadata || input.talentDescription);
        logger.info(
          `[CharacterSheetWorkflow:cf] Starting sheet generation for character ${input.characterName}${hasTalent ? ' with talent appearance' : ''}`
        );

        // Build talent overrides if talent data is provided (for casting)
        const talentOverrides = hasTalent
          ? {
              sheetMetadata: input.talentMetadata,
              description: input.talentDescription,
              sheetImageUrl: input.referenceImageUrl,
            }
          : undefined;

        // Build prompt with character identity + talent appearance + sequence style
        const { prompt, referenceUrls } = buildCharacterSheetPrompt(
          input.characterMetadata,
          talentOverrides,
          input.styleConfig
        );
        const model = input.imageModel ?? DEFAULT_IMAGE_MODEL;

        return {
          model,
          prompt,
          // Character sheets use landscape aspect ratio for multi-panel layout
          imageSize: 'landscape_16_9' as const,
          numImages: 1,
          // Use talent reference image(s) for visual consistency
          referenceImageUrls:
            referenceUrls.length > 0 ? referenceUrls : undefined,
        } satisfies ImageGenerationParams;
      }
    );

    // Step 2: Generate the character sheet image with a bounded same-model
    // reseed retry on content-flag rejections (#881/#939). A content rejection
    // is caught INSIDE the step and surfaced as a sentinel so CF's per-step
    // retry doesn't burn its budget re-rolling it — the loop owns that re-roll;
    // genuine transient errors still throw and lean on CF's per-step retries.
    // The sheet anchors a character's identity across cuts (#801), so an
    // exhausted budget is a HARD failure: we throw rather than persist a null
    // sheet and let the sequence render an unanchored character (#939).
    let imageResult: ImageGenerationResult | null = null;
    let lastRejection: string | null = null;
    for (let attempt = 0; attempt < MAX_SHEET_ATTEMPTS; attempt++) {
      const tag = attempt === 0 ? '' : `-retry-${attempt}`;
      const outcome = await step.do(
        `generate-sheet-image${tag}`,
        async (): Promise<
          | { ok: true; result: ImageGenerationResult }
          | { ok: false; rejection: string }
        > => {
          logger.info(
            `[CharacterSheetWorkflow:cf] Generating sheet for ${input.characterName} with model ${generationParams.model} (attempt ${attempt + 1}/${MAX_SHEET_ATTEMPTS})`
          );
          try {
            const result = await generateImageWithProvider(generationParams, {
              scopedDb,
            });
            return { ok: true, result };
          } catch (error) {
            if (isContentRejectionError(error)) {
              return { ok: false, rejection: extractFalErrorMessage(error) };
            }
            // Not a content flag → transient. Let CF retry the step.
            throw error;
          }
        }
      );

      if (outcome.ok) {
        imageResult = outcome.result;
        if (attempt > 0) {
          logger.info(
            `[CharacterSheetWorkflow:cf] content-flag retry rescued sheet for character ${input.characterDbId} on attempt ${attempt + 1}`,
            {
              event: CONTENT_REJECTION_RETRY_EVENT,
              outcome: 'rescued',
              kind: 'character-sheet',
              model: generationParams.model,
              attempts: attempt + 1,
              characterDbId: input.characterDbId,
              sequenceId: input.sequenceId,
            }
          );
        }
        break;
      }

      lastRejection = outcome.rejection;
      logger.warn(
        `[CharacterSheetWorkflow:cf] content-flag rejection on sheet attempt ${attempt + 1}/${MAX_SHEET_ATTEMPTS} for character ${input.characterDbId}: ${outcome.rejection}`
      );
    }

    if (!imageResult) {
      logger.error(
        `[CharacterSheetWorkflow:cf] content-flag retry exhausted for character ${input.characterDbId} after ${MAX_SHEET_ATTEMPTS} attempts`,
        {
          event: CONTENT_REJECTION_RETRY_EVENT,
          outcome: 'exhausted',
          kind: 'character-sheet',
          model: generationParams.model,
          attempts: MAX_SHEET_ATTEMPTS,
          characterDbId: input.characterDbId,
          sequenceId: input.sequenceId,
          rejection: lastRejection,
        }
      );
      throw new NonRetryableError(
        `Character sheet rejected by content filter after ${MAX_SHEET_ATTEMPTS} attempts: ${lastRejection ?? 'unknown rejection'}`,
        'ContentRejectionExhausted'
      );
    }

    // Deduct credits for image generation (skip if team used own fal key)
    await step.do('deduct-credits', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: extractImageCost(imageResult.metadata),
        usedOwnKey: imageResult.metadata.usedOwnKey,
        description: `Character sheet (${generationParams.model})`,
        idempotencyKey: `${event.instanceId}:sheet`,
        metadata: {
          model: generationParams.model,
          characterName: input.characterName,
          characterDbId: input.characterDbId,
        },
        workflowName: 'CharacterSheetWorkflow',
      });
    });

    const initialSheetImageUrl = imageResult.imageUrls[0];
    if (!initialSheetImageUrl) {
      throw new Error('Character sheet generation did not return an image URL');
    }
    let sheetImageUrl: string = initialSheetImageUrl;
    let sheetImagePath: string | undefined = undefined;

    if (input.characterDbId && input.teamId && input.sequenceId) {
      // Capture narrowed values so inner async closures see `string`, not
      // `string | undefined`.
      const characterDbId = input.characterDbId;
      const sequenceId = input.sequenceId;

      // Step 3: Upload to R2 storage
      const storageResult = await step.do('upload-to-storage', async () => {
        const imageUrl = imageResult.imageUrls[0];
        if (!imageUrl) {
          throw new Error('No image URL returned from generation');
        }

        logger.info(
          `[CharacterSheetWorkflow:cf] Uploading sheet to storage for ${input.characterName}`
        );

        // Fetch and stream directly to R2
        const response = await fetch(imageUrl);
        if (!response.ok) {
          throw new Error(
            `Failed to fetch generated image: ${response.status}`
          );
        }

        // Build storage path: characters/{teamId}/{sequenceId}/{characterDbId}/{uniqueId}.png
        const uniqueId = generateId();
        const storagePath = `${input.teamId}/${input.sequenceId}/${input.characterDbId}/${uniqueId}.png`;

        const result = await uploadResponse(
          response,
          STORAGE_BUCKETS.CHARACTERS,
          storagePath,
          {
            contentType: 'image/png',
          }
        );

        return {
          url: result.publicUrl,
          path: result.path,
        };
      });

      // Step 4: Divergence-aware database write. On convergent, update the
      // character's primary sheet. On divergent, preserve the artifact as a
      // variant row (the helper emits `stale:detected`) and skip the primary
      // update so the in-flight run does not overwrite a now-stale identity.
      const snapshotInputHash = input.snapshotInputHash ?? null;
      const reconcileOutcome = await step.do(
        'reconcile-database',
        async (): Promise<{ kind: 'convergent' } | { kind: 'divergent' }> => {
          logger.info(
            `[CharacterSheetWorkflow:cf] Updating database for ${input.characterName}`
          );

          const currentHash = snapshotInputHash
            ? await computeCharacterSheetHashCurrent(input, scopedDb)
            : null;

          const decision = decideSheetDivergence(
            snapshotInputHash,
            currentHash
          );

          if (decision.kind === 'divergent') {
            logger.warn('[CharacterSheetWorkflow:cf] divergence detected', {
              characterDbId: input.characterDbId,
              snapshotInputHash: decision.snapshotInputHash,
              currentInputHash: decision.currentInputHash,
              storagePath: storageResult.path,
            });
            await saveDivergentCharacterSheet({
              scopedDb,
              characterId: characterDbId,
              sequenceId,
              model: generationParams.model,
              url: storageResult.url,
              storagePath: storageResult.path,
              workflowRunId,
              snapshotInputHash: decision.snapshotInputHash,
            });
            return { kind: 'divergent' };
          }

          await scopedDb.characters.updateSheet(
            input.characterDbId,
            storageResult.url,
            storageResult.path,
            snapshotInputHash
          );
          return { kind: 'convergent' };
        }
      );

      sheetImagePath = storageResult.path;
      sheetImageUrl = storageResult.url;

      if (reconcileOutcome.kind === 'divergent') {
        // Helper already emitted `stale:detected` on the sequence channel.
        // Settle the primary sheet's status so the UI does not stay wedged on
        // "Regenerating…". The pre-existing `sheetImageUrl` (if any) remains
        // the live primary identity — we deliberately did not overwrite it.
        // For first-time generation the entity ends in `completed` with a
        // null sheetImageUrl; the user can manually retry. Either way,
        // flipping status to `completed` reflects "generation finished,
        // primary unchanged, divergent variant saved alongside".
        await step.do('settle-divergent-status', async () => {
          await scopedDb.characters.updateSheetStatus(
            characterDbId,
            'completed'
          );
          await getGenerationChannel(sequenceId).emit(
            'generation.character-sheet:progress',
            {
              characterId: characterDbId,
              status: 'completed',
            }
          );
        });
        logger.info(
          `[CharacterSheetWorkflow:cf] Diverged for ${input.characterName}; saved as variant`
        );
        return {
          sheetImageUrl,
          sheetImagePath,
          characterDbId: input.characterDbId,
        };
      }
    }
    // Emit realtime event that generation is complete
    await step.do('emit-complete-event', async () => {
      if (input.sequenceId && input.characterDbId) {
        await getGenerationChannel(input.sequenceId).emit(
          'generation.character-sheet:progress',
          {
            characterId: input.characterDbId,
            status: 'completed',
            sheetImageUrl,
          }
        );
      }
    });

    const result: CharacterSheetWorkflowResult = {
      sheetImageUrl,
      sheetImagePath,
      characterDbId: input.characterDbId,
    };

    return result;
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<CharacterSheetWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): Promise<void> {
    const input = event.payload;

    // Mark character sheet as failed
    if (input.characterDbId) {
      await scopedDb.characters.updateSheetStatus(
        input.characterDbId,
        'failed',
        error
      );

      // Emit failure event for realtime UI update
      if (input.sequenceId) {
        await getGenerationChannel(input.sequenceId).emit(
          'generation.character-sheet:progress',
          {
            characterId: input.characterDbId,
            status: 'failed',
            error,
          }
        );
      }

      if (isContentRejectionError(error)) {
        // Mirror image/motion `onFailure` so "how many sheets failed a content
        // checker" is one queryable PostHog Logs metric across all three paths.
        logger.warn(
          `[CharacterSheetWorkflow:cf] character ${input.characterDbId} sheet failed a content checker`,
          {
            event: CONTENT_REJECTION_EVENT,
            kind: 'character-sheet',
            model: input.imageModel ?? DEFAULT_IMAGE_MODEL,
            characterDbId: input.characterDbId,
            sequenceId: input.sequenceId,
            error,
          }
        );
      }

      logger.error(
        `[CharacterSheetWorkflow:cf] Sheet generation failed for character ${input.characterName}: ${error}`
      );
    }
  }
}
