/**
 * Cloudflare Workflows port of `sceneSplitWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/scene-split-workflow.ts`)
 * step for step — same step names, same control flow, same side effects.
 * Differences (all infrastructure-level, not behavioural):
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads payload from `event.payload`.
 *   - The streaming LLM call + per-chunk DB writes + per-chunk
 *     `generation.scene:*` event emissions + per-chunk preview-image
 *     fire-and-forget trigger all run inline inside a single top-level
 *     `step.do('scene-splitting-stream', …)`. If that step fails partway,
 *     the engine replays the entire LLM call — an accepted trade-off.
 *   - The final value returned from `scene-splitting-stream` is Zod-inferred
 *     and structurally rejected by CF's `Rpc.Serializable<T>` check, so we
 *     JSON-stringify around the step boundary (same pattern as
 *     `frame-prompt-workflow.ts`). */

import {
  callLLMStream,
  llmCostFromUsage,
  PROMPT_REASONING,
} from '@/lib/ai/llm-client';
import { PREVIEW_IMAGE_MODEL } from '@/lib/ai/models';
import { getContextWindow } from '@/lib/ai/models.config';
import {
  type SceneSplittingResult,
  sceneSplittingResultSchema,
} from '@/lib/ai/response-schemas';
import {
  createStreamingSceneParser,
  type SceneSplittingScene,
} from '@/lib/ai/streaming-scene-parser';
import type { Microdollars } from '@/lib/billing/money';
import type { TokenUsage } from '@tanstack/ai';
import { deductWorkflowCredits } from '@/lib/billing/workflow-deduction';
import {
  buildSceneInsert,
  buildSceneShotLinks,
} from '@/lib/ai/scene-persistence';
import { aspectRatioToImageSize } from '@/lib/constants/aspect-ratios';
import { dbSceneId, type NewShot } from '@/lib/db/schema';
import type { ScopedDb } from '@/lib/db/scoped';
import type { ShotWithAnchorFrame } from '@/lib/db/scoped/shots';
import { getChatPrompt } from '@/lib/prompts';
import { buildPreviewPrompt } from '@/lib/prompts/poster-prompt';
import { getGenerationChannel } from '@/lib/realtime';
import { previewImageDedupId } from '@/lib/workflow/dedup-ids';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import { handleLlmAuthFailure } from '@/lib/workflow/llm-auth-failure';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import type {
  ImageWorkflowInput,
  SceneSplitWorkflowInput,
  SceneSplitWorkflowResult,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'scene-split']);

const PHASE = { number: 1, name: 'Analyzing script…' } as const;
const STEP_NAME = 'scene-splitting';
const LOG_NAME = `phase-${PHASE.number}-${STEP_NAME}`;
const LOG_TAGS = [STEP_NAME, `phase-${PHASE.number}`, 'analysis'];
const LOG_METADATA = { phase: PHASE.number, phaseName: PHASE.name };

/**
 * Persist one analysis scene as a `scenes` row and its 1:1 shot, linked via
 * `shots.sceneId`, as soon as the stream emits it. Without this the Scenes
 * spine (#986) only has flat unassigned shots until the late `persist-scenes`
 * step — the pre-#1055 look. Multi-shot analysis (#910) will attach N shots
 * to the same scene row; today every scene is still one shot at shotNumber 1.
 */
async function persistStreamedSceneAndShot(
  scopedDb: ScopedDb,
  sequenceId: string,
  scene: SceneSplittingScene,
  orderIndex: number
): Promise<ShotWithAnchorFrame> {
  const sceneRow = await scopedDb.scenes.upsert(
    buildSceneInsert(sequenceId, scene, orderIndex)
  );
  // Seed the split script version as soon as the scene lands so composed
  // script / the Scenes script view have text mid-stream. Idempotent: the
  // final persist-scenes step re-seeds without duplicating.
  await scopedDb.sceneScriptVersions.seedSplitFromSceneRows([sceneRow]);
  return scopedDb.shots.upsert({
    sequenceId,
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    description: scene.originalScript?.extract || '',
    orderIndex,
    metadata: scene,
    durationMs: Math.round(
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      (scene.metadata?.durationSeconds || 3) * 1000
    ),
    videoStatus: 'pending',
    sceneId: sceneRow.id,
    shotNumber: 1,
  } satisfies NewShot);
}

/**
 * Shape produced by the streaming step (post JSON round-trip). Mirrors the
 * QStash `streamResult` value — note `projectMetadata` is preserved so the
 * reconcile step can extract the title, and `shotMapping` reflects only the
 * shots written inline during streaming.
 */
type StreamResult = {
  scenes: SceneSplittingResult['scenes'];
  projectMetadata: SceneSplittingResult['projectMetadata'];
  shotMapping: Array<{
    analysisSceneId: string;
    shotId: string;
    frameId: string | null;
  }>;
  characterBible: SceneSplittingResult['characterBible'];
  locationBible: SceneSplittingResult['locationBible'];
  elementBible: SceneSplittingResult['elementBible'];
  /** Provider-reported cost for the LLM call, billed after reconciliation. */
  llmCostMicros: Microdollars;
};

export class SceneSplitWorkflow extends OpenStoryWorkflowEntrypoint<SceneSplitWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<SceneSplitWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<SceneSplitWorkflowResult> {
    const input = event.payload;
    const {
      sequenceId,
      modelId,
      styleConfig,
      aspectRatio,
      elements = [],
    } = input;

    // Gap C: this single `step.do` owns the prompt fetch + the entire
    // streaming session. Inside, the partial-JSON parser, per-chunk DB writes
    // (upsertShot), per-chunk realtime event emissions
    // (`generation.scene:new`, `generation.shot:created`,
    // `generation.scene:updated`, `generation.updated`,
    // `generation.phase:start`) and per-chunk fire-and-forget preview-image
    // triggers all run inline. On step failure the engine replays the whole
    // stream — acceptable per the investigation. The prompt fetch is folded
    // in so the per-chunk side effects share the same retry boundary as the
    // LLM call that produced them. JSON-stringify the final value around the
    // boundary so the Zod-inferred result survives CF's `Rpc.Serializable<T>`
    // typecheck.
    const streamResultJson = await step.do(
      'scene-splitting-stream',
      async (): Promise<string> => {
        const elementsBlock =
          elements.length > 0
            ? elements
                .map((el) => {
                  // analyzeScriptWorkflow refuses to start while any element
                  // is pending/analyzing, so a null description here means
                  // vision genuinely failed for this row.
                  const desc = el.description
                    ? `: ${el.description}`
                    : ' (no visual reference available)';
                  return `- ${el.token}${desc}`;
                })
                .join('\n')
            : '(none)';
        const { messages } = await getChatPrompt(input.promptName, {
          aspectRatio,
          script: input.script,
          elements: elementsBlock,
        });

        const llmKeyInfo = await scopedDb.apiKeys.resolveLlmKey();

        logger.info(
          `[SceneSplitWorkflow:cf] [LLM:${LOG_NAME}] Starting streaming call`,
          {
            model: modelId,
            keySource: llmKeyInfo.source,
            keyVia: llmKeyInfo.via,
            messageCount: messages.length,
          }
        );

        const parser = createStreamingSceneParser();
        const shotMapping: Array<{
          analysisSceneId: string;
          shotId: string;
          frameId: string | null;
        }> = [];
        let finalText = '';
        let chunkCount = 0;
        let prevScene: SceneSplittingScene | undefined = undefined;
        let prevShotId: string | undefined = undefined;
        let parsedResult: SceneSplittingResult | undefined;
        let capturedUsage: TokenUsage | undefined;

        for await (const chunk of callLLMStream<SceneSplittingResult>({
          model: modelId,
          messages,
          max_tokens: Math.floor(getContextWindow(modelId) * 0.65),
          responseSchema: sceneSplittingResultSchema,
          apiKey: llmKeyInfo,
          reasoning: PROMPT_REASONING,
          observationName: LOG_NAME,
          tags: LOG_TAGS,
          metadata: LOG_METADATA,
          userId: input.userId,
          sessionId: input.sequenceId,
        })) {
          if (chunk.done) {
            if (chunk.parsed !== undefined) parsedResult = chunk.parsed;
            capturedUsage = chunk.usage;
          }
          chunkCount++;
          finalText = chunk.accumulated;
          const events = parser.feed(chunk.accumulated);

          if (chunkCount % 20 === 0) {
            logger.info(
              `[SceneSplitWorkflow:cf] [Stream:${LOG_NAME}] chunk #${chunkCount} | ${finalText.length} chars | ${shotMapping.length} shots so far`
            );
          }

          for (const ev of events) {
            if (ev.type === 'title' && sequenceId) {
              logger.info(
                `[SceneSplitWorkflow:cf] [Stream:${LOG_NAME}] Title detected: "${ev.title}" (chunk #${chunkCount})`
              );
              await scopedDb.sequences.updateTitle(sequenceId, ev.title);
              await getGenerationChannel(sequenceId).emit(
                'generation.updated',
                { title: ev.title }
              );
            }

            if (ev.type === 'characterBible' && sequenceId) {
              logger.info(
                `[SceneSplitWorkflow:cf] [Stream:${LOG_NAME}] Character bible detected (${ev.bible.length} entries), advancing to phase 2`
              );
              await getGenerationChannel(sequenceId).emit(
                'generation.phase:start',
                {
                  phase: 2,
                  phaseName: 'Casting characters & locations…',
                }
              );
            }

            if (ev.type === 'scene:updated') {
              logger.info(
                // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                `[SceneSplitWorkflow:cf] [Stream:${LOG_NAME}] Scene ${ev.index + 1} title updated: "${ev.scene.metadata?.title}" (chunk #${chunkCount})`
              );

              // Partial scenes still get a scenes row + linked shot so the
              // spine shows the new grouped layout mid-stream (#1072).
              // Persist before emit so invalidation doesn't race the write.
              if (sequenceId) {
                await persistStreamedSceneAndShot(
                  scopedDb,
                  sequenceId,
                  ev.scene,
                  ev.index
                );
              }

              await getGenerationChannel(sequenceId).emit(
                'generation.scene:updated',
                {
                  sceneId: ev.scene.sceneId,
                  sceneNumber: ev.scene.sceneNumber,
                  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                  title: ev.scene.metadata?.title || 'Untitled Scene',
                  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                  scriptExtract: ev.scene.originalScript?.extract || '',
                  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                  durationSeconds: ev.scene.metadata?.durationSeconds || 3,
                }
              );
            }

            if (ev.type === 'scene') {
              logger.info(
                // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                `[SceneSplitWorkflow:cf] [Stream:${LOG_NAME}] Scene ${ev.index + 1} complete: "${ev.scene.metadata?.title}" (chunk #${chunkCount}, ${finalText.length} chars)`
              );

              if (sequenceId) {
                // Persist before emitting so cache invalidation from the
                // realtime events cannot race ahead of the DB write (#1072).
                const shot = await persistStreamedSceneAndShot(
                  scopedDb,
                  sequenceId,
                  ev.scene,
                  ev.index
                );

                logger.info(
                  `[SceneSplitWorkflow:cf] [Stream:${LOG_NAME}] Shot created: ${shot.id} for scene "${ev.scene.sceneId}" (db scene linked)`
                );

                shotMapping.push({
                  analysisSceneId: ev.scene.sceneId,
                  shotId: shot.id,
                  // Anchor frame id captured from the same write (no read-back).
                  frameId: shot.anchorFrameId,
                });

                await getGenerationChannel(sequenceId).emit(
                  'generation.scene:new',
                  {
                    sceneId: ev.scene.sceneId,
                    sceneNumber: ev.scene.sceneNumber,
                    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                    title: ev.scene.metadata?.title || 'Untitled Scene',
                    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                    scriptExtract: ev.scene.originalScript?.extract || '',
                    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                    durationSeconds: ev.scene.metadata?.durationSeconds || 3,
                  }
                );

                await getGenerationChannel(sequenceId).emit(
                  'generation.shot:created',
                  {
                    shotId: shot.id,
                    sceneId: ev.scene.sceneId,
                    orderIndex: ev.index,
                  }
                );
                if (prevScene && prevShotId) {
                  const sceneText =
                    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                    prevScene.originalScript?.extract ??
                    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                    prevScene.metadata?.title ??
                    'A cinematic scene';
                  const prompt = buildPreviewPrompt(sceneText, styleConfig);

                  // Fire-and-forget preview-image trigger for the previous
                  // scene. Routed through `triggerWorkflow` so the engine
                  // registry picks whichever engine is configured for
                  // `/image` at runtime. The deduplicationId makes a replay
                  // of this mega-step idempotent (see dedup-ids.ts).
                  await triggerWorkflow(
                    '/image',
                    {
                      userId: input.userId,
                      teamId: input.teamId,
                      sequenceId,
                      prompt,
                      model: PREVIEW_IMAGE_MODEL,
                      imageSize: aspectRatioToImageSize(aspectRatio),
                      numImages: 1,
                      shotId: prevShotId,
                      skipStorage: true,
                    } satisfies ImageWorkflowInput,
                    {
                      label: buildWorkflowLabel(sequenceId),
                      deduplicationId: previewImageDedupId(
                        event.instanceId,
                        prevShotId
                      ),
                    }
                  );
                }

                prevShotId = shot.id;
              }
              prevScene = ev.scene;
            }
          }
        }

        // Trigger preview for the last scene (the loop only triggers N-1).
        if (prevScene && prevShotId && sequenceId) {
          const sceneText =
            // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
            prevScene.originalScript?.extract ??
            // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
            prevScene.metadata?.title ??
            'A cinematic scene';
          const prompt = buildPreviewPrompt(sceneText, styleConfig);

          await triggerWorkflow(
            '/image',
            {
              userId: input.userId,
              teamId: input.teamId,
              sequenceId,
              prompt,
              model: PREVIEW_IMAGE_MODEL,
              imageSize: aspectRatioToImageSize(aspectRatio),
              numImages: 1,
              shotId: prevShotId,
              skipStorage: true,
            } satisfies ImageWorkflowInput,
            {
              label: buildWorkflowLabel(sequenceId),
              deduplicationId: previewImageDedupId(
                event.instanceId,
                prevShotId
              ),
            }
          );
        }

        if (!parsedResult) {
          throw new NonRetryableError(
            `[SceneSplitWorkflow:cf] [Stream:${LOG_NAME}] Stream ended without a validated structured-output payload. ` +
              `chunks=${chunkCount} chars=${finalText.length} ` +
              `streamedScenes=${shotMapping.length} model=${modelId}. ` +
              `Likely cause: provider did not honor responseFormat:json_schema.`
          );
        }
        const parsed = parsedResult;
        logger.info(
          `[SceneSplitWorkflow:cf] [Stream:${LOG_NAME}] Complete | ${chunkCount} chunks | ${parsed.scenes.length} scenes | ${finalText.length} chars`
        );

        // JSON round-trip: the inferred shape contains Zod discriminated
        // unions / catch-defaulted arrays that confuse CF's
        // `Rpc.Serializable<T>` typecheck. The value is JSON-clean at
        // runtime; stringify on the way out, parse on the way in.
        const streamResult: StreamResult = {
          scenes: parsed.scenes,
          projectMetadata: parsed.projectMetadata,
          shotMapping,
          characterBible: parsed.characterBible,
          locationBible: parsed.locationBible,
          elementBible: parsed.elementBible,
          llmCostMicros: llmCostFromUsage(capturedUsage, modelId),
        };
        return JSON.stringify(streamResult);
      }
    );
    // Defensive shape check on replay — the data was Zod-validated once
    // inside the step, but if CF's step-cache persisted something corrupt
    // we fail loud here instead of silently downstream.
    const streamResult: StreamResult = JSON.parse(streamResultJson);
    if (
      !Array.isArray(streamResult.scenes) ||
      !Array.isArray(streamResult.shotMapping)
    ) {
      throw new NonRetryableError(
        'scene-splitting-stream returned a malformed result from cache',
        'WorkflowValidationError'
      );
    }

    // Step 3: Reconcile — ensure all shots exist (handles cached step replay).
    const reconcileJson = await step.do(
      'reconcile-shots',
      async (): Promise<string> => {
        const { scenes, projectMetadata } = streamResult;
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
        const resolvedTitle = projectMetadata?.title || 'Untitled';

        if (!sequenceId) {
          return JSON.stringify({
            scenes,
            title: resolvedTitle,
            shotMapping: streamResult.shotMapping,
            characterBible: streamResult.characterBible,
            locationBible: streamResult.locationBible,
            elementBible: streamResult.elementBible,
          } satisfies SceneSplitWorkflowResult);
        }

        // Bulk upsert scenes first, then shots with sceneId links. Shots'
        // onConflictDoUpdate overwrites sceneId from the insert payload —
        // omitting it here would null out the stream-time links (#1072).
        const sceneRows = [];
        for (let index = 0; index < scenes.length; index++) {
          const scene = scenes[index];
          if (!scene) continue;
          sceneRows.push(
            await scopedDb.scenes.upsert(
              buildSceneInsert(sequenceId, scene, index)
            )
          );
        }
        const sceneIdByOrderIndex = new Map(
          sceneRows.map((row) => [row.orderIndex, row.id])
        );

        const shotInserts = scenes.map(
          (scene, index) =>
            ({
              sequenceId,
              // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
              description: scene.originalScript?.extract || '',
              orderIndex: index,
              metadata: scene,
              durationMs: Math.round(
                // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                (scene.metadata?.durationSeconds || 3) * 1000
              ),
              videoStatus: 'pending',
              sceneId: sceneIdByOrderIndex.get(index) ?? null,
              shotNumber: 1,
            }) satisfies NewShot
        );

        const reconciledShots = await scopedDb.shots.bulkUpsert(shotInserts);
        const reconciledMapping = reconciledShots.map((f) => ({
          // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: metadata is JSONB, can be null despite Drizzle types
          analysisSceneId: f.metadata?.sceneId || '',
          shotId: f.id,
          // Anchor frame id captured from the same bulkUpsert write — the batch
          // prompt workflow reads it from here instead of querying the DB (#991).
          frameId: f.anchorFrameId,
        }));

        // Ensure title and workflow are set (status stays 'processing'
        // until storyboard-workflow completes all phases).
        await scopedDb.sequences.updateTitle(sequenceId, resolvedTitle);
        await scopedDb.sequences.updateWorkflow(
          sequenceId,
          'analyze-script-shorter-prompts-batch-size-1'
        );

        // Emit shot:created for any shots the streaming step didn't cover.
        const streamedSceneIds = new Set(
          streamResult.shotMapping.map((f) => f.analysisSceneId)
        );
        for (const { analysisSceneId: sId, shotId } of reconciledMapping) {
          if (!streamedSceneIds.has(sId)) {
            const scene = scenes.find((s) => s.sceneId === sId);
            await getGenerationChannel(sequenceId).emit(
              'generation.shot:created',
              {
                shotId,
                sceneId: sId,
                orderIndex: scene?.sceneNumber ? scene.sceneNumber - 1 : 0,
              }
            );
          }
        }

        return JSON.stringify({
          scenes,
          title: resolvedTitle,
          shotMapping: reconciledMapping,
          characterBible: streamResult.characterBible,
          locationBible: streamResult.locationBible,
          elementBible: streamResult.elementBible,
        } satisfies SceneSplitWorkflowResult);
      }
    );
    const reconciled: SceneSplitWorkflowResult = JSON.parse(reconcileJson);
    if (
      !Array.isArray(reconciled.scenes) ||
      !Array.isArray(reconciled.shotMapping)
    ) {
      throw new NonRetryableError(
        'reconcile-shots returned a malformed result from cache',
        'WorkflowValidationError'
      );
    }

    // Step 4: Reconcile element bible → update firstMention on existing rows.
    if (sequenceId && reconciled.elementBible.length > 0) {
      await step.do('reconcile-element-bible', async () => {
        for (const entry of reconciled.elementBible) {
          const existing = await scopedDb.sequenceElements.getByToken(
            sequenceId,
            entry.token
          );
          if (!existing) continue;
          await scopedDb.sequenceElements.updateFirstMention(existing.id, {
            sceneId: entry.firstMention.sceneId,
            text: entry.firstMention.text,
            lineNumber: entry.firstMention.lineNumber,
          });
        }
      });
    }

    // Step 4b (#908 / #1072): authoritative upsert of `scenes` rows + shot
    // links after reconcile. Streaming and reconcile already wrote 1:1 rows;
    // this step re-upserts the final set (stable ids via orderIndex), re-links
    // shots, seeds scene_script_versions, and trims orphan tail rows if a
    // re-analyze produced fewer scenes.
    //
    // Do NOT delete-then-recreate: `shots.scene_id` is a bare
    // `REFERENCES scenes(id)` in the migration (no ON DELETE SET NULL), so
    // deleting stream-linked scenes fails with DrizzleQueryError (#1072).
    if (sequenceId && reconciled.scenes.length > 0) {
      await step.do('persist-scenes', async () => {
        const sceneRows = [];
        for (let index = 0; index < reconciled.scenes.length; index++) {
          const scene = reconciled.scenes[index];
          if (!scene) continue;
          sceneRows.push(
            await scopedDb.scenes.upsert(
              buildSceneInsert(sequenceId, scene, index)
            )
          );
        }

        // Link each shot to its scene row by analysisSceneId → orderIndex →
        // row (see buildSceneShotLinks — keyed on the unique orderIndex, not
        // array position). A shot whose scene is missing is surfaced, not
        // silently skipped: every mapped shot should belong to a scene.
        const { links, unmappedShotIds } = buildSceneShotLinks(
          reconciled.scenes,
          sceneRows,
          reconciled.shotMapping
        );
        if (unmappedShotIds.length > 0) {
          logger.warn(
            `[SceneSplitWorkflow:cf] persist-scenes: ${unmappedShotIds.length} shot(s) had no matching scene row`,
            { sequenceId, unmappedShotIds }
          );
        }

        const keptSceneIds = new Set(sceneRows.map((row) => row.id));
        const missingShotIds: string[] = [];
        for (const { shotId, sceneId, shotNumber } of links) {
          const updated = await scopedDb.shots.update(
            shotId,
            { sceneId, shotNumber },
            { throwOnMissing: false }
          );
          if (!updated) missingShotIds.push(shotId);
        }
        if (missingShotIds.length > 0) {
          logger.warn(
            `[SceneSplitWorkflow:cf] persist-scenes: ${missingShotIds.length} shot(s) missing at link time`,
            { sequenceId, missingShotIds }
          );
        }

        // Before trimming orphan tail scenes, clear any shot links that still
        // point at them (re-analyze edge: fewer scenes than last run). The
        // migration FK is RESTRICT-by-default without ON DELETE SET NULL.
        const allShots = await scopedDb.shots.listBySequence(sequenceId);
        for (const shot of allShots) {
          if (shot.sceneId && !keptSceneIds.has(dbSceneId(shot.sceneId))) {
            await scopedDb.shots.update(
              shot.id,
              { sceneId: null, shotNumber: null },
              { throwOnMissing: false }
            );
          }
        }
        await scopedDb.scenes.deleteFromOrderIndex(
          sequenceId,
          reconciled.scenes.length
        );

        await scopedDb.sceneScriptVersions.seedSplitFromSceneRows(sceneRows);
      });
    }

    // Step 5: Deduct credits.
    const llmCreditKeyInfo = await scopedDb.apiKeys.resolveLlmKey();
    await step.do('deduct-llm-credits-scene-splitting', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: streamResult.llmCostMicros,
        usedOwnKey: llmCreditKeyInfo.source === 'team',
        description: `LLM analysis (${modelId})`,
        idempotencyKey: `${event.instanceId}:llm-${STEP_NAME}`,
        metadata: {
          model: modelId,
          phase: PHASE.number,
          phaseName: PHASE.name,
          stepName: STEP_NAME,
          sequenceId,
          costMicros: streamResult.llmCostMicros,
        },
      });
    });

    return reconciled;
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<SceneSplitWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): Promise<void> {
    const { sequenceId } = event.payload;
    logger.error('[SceneSplitWorkflow:cf] Failure:', {
      err: error,
    });

    const userMessage =
      (await handleLlmAuthFailure(scopedDb, sanitizeFailResponse(error))) ??
      'Scene splitting failed';

    if (sequenceId) {
      try {
        await getGenerationChannel(sequenceId).emit('generation.error', {
          message: userMessage,
        });
      } catch (emitError) {
        logger.error(
          `[SceneSplitWorkflow:cf] Failed to emit failure event for sequence ${sequenceId}:`,
          {
            err: emitError,
          }
        );
      }
    }
  }
}
