/**
 * Per-scene visual (image) prompt generation.
 *
 * Extends `OpenStoryWorkflowEntrypoint` (failure handling comes from the base
 * class, see base-workflow.ts) and runs its durable work through `step.do`. The
 * streaming LLM call is inlined here (steps `prepare-visual-prompts`,
 * `visual-prompts` / `visual-prompts-stream`, `deduct-llm-credits-visual-prompts`).
 * The generated prompt is persisted to `frame_prompt_versions` and mirrored onto
 * the anchor frame — not into `scene.metadata` (#713). Spawned per scene by
 * `FramePromptBatchWorkflow`. */

import { createAdapter } from '@/lib/ai/create-adapter';
import { computeVisualPromptInputHash } from '@/lib/ai/input-hash';
import {
  extractRunError,
  formatRunErrorMessage,
  llmCostFromUsage,
  PROMPT_REASONING,
} from '@/lib/ai/llm-client';
import { getContextWindow } from '@/lib/ai/models.config';
import { narrowShotPromptContext } from '@/lib/ai/prompt-context';
import {
  type VisualPrompt,
  type VisualPromptResult,
  visualPromptResultSchema,
} from '@/lib/ai/scene-analysis.schema';
import { extractStreamingStringField } from '@/lib/ai/stream-extract';
import type { Microdollars } from '@/lib/billing/money';
import { deductWorkflowCredits } from '@/lib/billing/workflow-deduction';
import type { ScopedDb } from '@/lib/db/scoped';
import { getLogger } from '@/lib/observability/logger';
import { getChatPrompt } from '@/lib/prompts';
import { getShotPromptChannel, getGenerationChannel } from '@/lib/realtime';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type { FramePromptWorkflowInput } from '@/lib/workflow/types';
import { chat, type TokenUsage } from '@tanstack/ai';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

const logger = getLogger(['openstory', 'workflow', 'frame-prompt']);

type FramePromptResult = { sceneId: string; visual: VisualPrompt };

const PHASE = { number: 3, name: 'Writing image prompts…' } as const;
const STEP_NAME = 'visual-prompts';
const LOG_NAME = `phase-${PHASE.number}-${STEP_NAME}`;
const LOG_TAGS = [STEP_NAME, `phase-${PHASE.number}`, 'analysis'] as const;
const LOG_TAGS_STREAM = [...LOG_TAGS, 'stream'] as const;

export class FramePromptWorkflow extends OpenStoryWorkflowEntrypoint<FramePromptWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<FramePromptWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<FramePromptResult> {
    const input = event.payload;
    const {
      scene,
      sceneBefore,
      sceneAfter,
      aspectRatio,
      characterBible,
      locationBible,
      elementBible = [],
      styleConfig,
      analysisModelId,
      shotId,
      frameId,
      sequenceId,
      userId,
      emitStreaming,
    } = input;

    // Membership is supplied upstream by scene-split (`scene.continuity`), so
    // narrow the bibles to just this scene's entities BEFORE the LLM call. The
    // LLM and the staleness hash then consume the same minimal, scene-scoped
    // input — no full-bible pass for the model to wade through, and the stored
    // hash matches the verify-time recompute by construction. See #867.
    const narrowed = narrowShotPromptContext({
      scene,
      styleConfig,
      characterBible,
      locationBible,
      elementBible,
      aspectRatio,
      analysisModel: analysisModelId,
    });

    const streamConfig =
      emitStreaming && shotId
        ? { shotId, promptType: 'visual' as const, flushIntervalMs: 80 }
        : undefined;

    const logMetadata = {
      phase: PHASE.number,
      phaseName: PHASE.name,
      shotId,
    };

    // Step 1: Prepare — fetch prompt from Langfuse.
    const { messages, promptReference } = await step.do(
      `prepare-${STEP_NAME}`,
      async () => {
        const { messages: msgs } = await getChatPrompt(
          'phase/visual-prompt-scene-generation-chat',
          {
            sceneBefore: sceneBefore
              ? JSON.stringify(sceneBefore, null, 2)
              : '(none)',
            sceneAfter: sceneAfter
              ? JSON.stringify(sceneAfter, null, 2)
              : '(none)',
            scene: JSON.stringify(scene, null, 2),
            characterBible: JSON.stringify(narrowed.characterBible, null, 2),
            locationBible: JSON.stringify(narrowed.locationBible, null, 2),
            elementBible: JSON.stringify(narrowed.elementBible, null, 2),
            styleConfig: JSON.stringify(styleConfig, null, 2),
            aspectRatio,
          }
        );
        return { messages: msgs, promptReference: undefined };
      }
    );

    // Step 2: Durable LLM call (streaming or non-streaming depending on
    // whether `emitStreaming` was set by the caller). Step name matches
    // `durableStreamingLLMCall`'s exactly so trace parity holds.
    const llmStepName = streamConfig ? `${STEP_NAME}-stream` : STEP_NAME;

    // Resolved once, outside the steps, so the LLM call and the deduction
    // step attribute billing to the same key (the per-scope row cache makes
    // this at most one D1 read).
    const llmKeyInfo = await scopedDb.apiKeys.resolveLlmKey();

    // VisualPromptResult is a Zod-inferred object that doesn't satisfy CF's
    // `Rpc.Serializable<T>` constraint structurally (the discriminated union
    // members confuse the check), but is JSON-safe at runtime. JSON-stringify
    // around the step boundary so the type round-trips through Serializable
    // cleanly.
    const { resultJson, costMicros } = await step.do(
      llmStepName,
      async (): Promise<{ resultJson: string; costMicros: Microdollars }> => {
        const adapter = createAdapter(analysisModelId, llmKeyInfo);
        let capturedUsage: TokenUsage | undefined;
        const captureUsage = [
          {
            onFinish: (_ctx: unknown, info: { usage?: TokenUsage }) => {
              capturedUsage = info.usage;
            },
          },
        ];

        logger.info(
          `[FramePromptWorkflow:cf] [LLM:${LOG_NAME}] Starting${
            streamConfig ? ' streaming' : ''
          } call`,
          {
            model: analysisModelId,
            keySource: llmKeyInfo.source,
            keyVia: llmKeyInfo.via,
            messageCount: messages.length,
            ...(streamConfig
              ? {
                  shotId: streamConfig.shotId,
                  promptType: streamConfig.promptType,
                }
              : {}),
          }
        );

        const systemPrompts: string[] = [];
        const chatMessages: Array<{
          role: 'user' | 'assistant';
          content: string;
        }> = [];
        for (const msg of messages) {
          const flat =
            typeof msg.content === 'string'
              ? msg.content
              : msg.content
                  .map((part) => (part.type === 'text' ? part.content : ''))
                  .filter(Boolean)
                  .join('\n');
          if (msg.role === 'system') {
            systemPrompts.push(flat);
          } else {
            chatMessages.push({ role: msg.role, content: flat });
          }
        }

        const abortController = new AbortController();
        const timeout = setTimeout(() => abortController.abort(), 300_000);

        // Reasoning lifts prompt-generation quality. Enabled in E2E too — it's
        // deterministic once recorded, so aimock records + replays it normally.
        const reasoningOptions = { reasoning: PROMPT_REASONING };

        try {
          if (!streamConfig) {
            const text = await chat({
              adapter,
              messages: chatMessages,
              systemPrompts: systemPrompts,
              outputSchema: visualPromptResultSchema,
              stream: false,
              abortController,
              modelOptions: {
                ...reasoningOptions,
                maxCompletionTokens: Math.floor(
                  getContextWindow(analysisModelId) * 0.5
                ),
              },
              metadata: {
                observationName: LOG_NAME,
                prompt: promptReference,
                tags: [...LOG_TAGS],
                metadata: logMetadata,
                sessionId: sequenceId,
                userId,
              },
              middleware: captureUsage,
              debug: false,
            });
            logger.info(
              `[FramePromptWorkflow:cf] [LLM:${LOG_NAME}] Call succeeded`
            );
            return {
              resultJson: JSON.stringify(text),
              costMicros: llmCostFromUsage(capturedUsage, analysisModelId),
            };
          }

          // Streaming path — emit visible `fullPrompt` deltas while accumulating.
          const channel = getShotPromptChannel(streamConfig.shotId);
          let accumulated = '';
          let lastExtracted = '';
          let pendingDelta = '';
          let lastEmitAt = 0;

          const flushDelta = async () => {
            if (!pendingDelta) return;
            const delta = pendingDelta;
            pendingDelta = '';
            lastEmitAt = Date.now();
            await channel.emit('shotPrompt.streaming', {
              promptType: streamConfig.promptType,
              delta,
            });
          };

          for await (const streamEvent of chat({
            adapter,
            messages: chatMessages,
            systemPrompts: systemPrompts,
            stream: true,
            abortController,
            modelOptions: {
              ...reasoningOptions,
              maxCompletionTokens: Math.floor(
                getContextWindow(analysisModelId) * 0.5
              ),
            },
            metadata: {
              observationName: LOG_NAME,
              prompt: promptReference,
              tags: [...LOG_TAGS_STREAM],
              metadata: logMetadata,
              sessionId: sequenceId,
              userId,
            },
            outputSchema: visualPromptResultSchema,
            middleware: captureUsage,
            debug: false,
          })) {
            if (
              streamEvent.type === 'TEXT_MESSAGE_CONTENT' &&
              typeof streamEvent.delta === 'string'
            ) {
              accumulated += streamEvent.delta;
              const next = extractStreamingStringField(
                accumulated,
                'fullPrompt'
              );
              if (next.length > lastExtracted.length) {
                pendingDelta += next.slice(lastExtracted.length);
                lastExtracted = next;
              }
              if (
                pendingDelta &&
                Date.now() - lastEmitAt >= streamConfig.flushIntervalMs
              ) {
                await flushDelta();
              }
              continue;
            }
            const runError = extractRunError(streamEvent);
            if (runError) {
              logger.error(
                `[FramePromptWorkflow:cf] [LLM:${LOG_NAME}] Streaming call RUN_ERROR`,
                { runError: runError.event }
              );
              throw new Error(formatRunErrorMessage(runError));
            }
          }
          await flushDelta();
          logger.info(
            `[FramePromptWorkflow:cf] [LLM:${LOG_NAME}] Streaming call succeeded`
          );
          return {
            resultJson: JSON.stringify(
              visualPromptResultSchema.parse(JSON.parse(accumulated))
            ),
            costMicros: llmCostFromUsage(capturedUsage, analysisModelId),
          };
        } finally {
          clearTimeout(timeout);
        }
      }
    );
    const result: VisualPromptResult = visualPromptResultSchema.parse(
      JSON.parse(resultJson)
    );

    // Step 3: Deduct LLM credits.
    await step.do(`deduct-llm-credits-${STEP_NAME}`, async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros,
        usedOwnKey: llmKeyInfo.source === 'team',
        description: `LLM analysis (${analysisModelId})`,
        idempotencyKey: `${event.instanceId}:llm-${STEP_NAME}`,
        metadata: {
          model: analysisModelId,
          phase: PHASE.number,
          phaseName: PHASE.name,
          stepName: STEP_NAME,
          sequenceId,
          costMicros,
        },
      });
    });

    if (sequenceId && shotId) {
      if (!result.visual.fullPrompt) {
        throw new WorkflowValidationError(
          `Visual prompt generation returned empty fullPrompt for scene ${scene.sceneId}`
        );
      }

      // Hash the same scene-scoped `narrowed` context the LLM was given above,
      // so the stored hash equals the verify-time recompute by construction.
      const inputHash = await computeVisualPromptInputHash(narrowed);

      await step.do('save-visual-prompt-to-db', async () => {
        // The anchor `frameId` is resolved by the parent and passed in (#991:
        // workflows don't read the DB). It is mandatory whenever we have a shot to
        // save to — every shot owns an anchor frame (materialized at shot
        // creation), so a null here inside the `sequenceId && shotId` guard is an
        // invariant violation (broken shotMapping / missing anchor), NOT an
        // expected skip. Fail loud rather than silently drop the prompt: a soft
        // warn would leave `frame.imagePrompt` null, disable staleness, and show
        // an empty history sheet while the run still reports success.
        if (!frameId) {
          throw new WorkflowValidationError(
            `Shot ${shotId} has no anchor frame id in shotMapping; cannot persist visual prompt for scene ${scene.sceneId}`
          );
        }
        // The prompt is NOT written into `scene.metadata` any more (#713):
        // the version write mirrors its text onto `frame.imagePrompt` and
        // repoints `selectedImagePromptVersionId`, superseding any prior
        // user-override automatically (the override stays in history and can
        // be restored).
        if (input.targetVersionId) {
          // #1085: a pre-created pending claim row exists — complete it in
          // place. Null result = the claim was cancelled mid-flight; the
          // output is deliberately discarded (nothing mirrored, no event).
          const completed =
            await scopedDb.framePromptVersions.completePendingAiVersion({
              versionId: input.targetVersionId,
              frameId,
              text: result.visual.fullPrompt,
              components: result.visual.components,
              inputHash,
              analysisModel: analysisModelId,
            });
          if (!completed) {
            logger.info(
              `[FramePromptWorkflow:cf] claim ${input.targetVersionId} was cancelled mid-run; output discarded`
            );
            return;
          }
        } else {
          await scopedDb.framePromptVersions.writeAiVersion({
            frameId,
            text: result.visual.fullPrompt,
            components: result.visual.components,
            inputHash,
            analysisModel: analysisModelId,
          });
        }

        // The generated prompt now lives on `frame.imagePrompt` (mirror), not
        // in `metadata`; carry the base scene so the client refreshes the shot
        // (and re-projects `imagePrompt`) on this event.
        await getGenerationChannel(sequenceId).emit('generation.shot:updated', {
          shotId,
          updateType: 'visual-prompt',
          metadata: scene,
        });

        // Signal end-of-stream to the per-shot channel so the UI can swap
        // out the streamed-deltas buffer for the persisted prompt.
        if (emitStreaming) {
          await getShotPromptChannel(shotId).emit('shotPrompt.completed', {
            promptType: 'visual',
          });
        }
      });
    }

    return { sceneId: scene.sceneId, ...result };
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<FramePromptWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): Promise<void> {
    const payload = event.payload;
    logger.error('[FramePromptWorkflow:cf] Failed', {
      workflowRunId: event.instanceId,
      error,
    });
    // #1085: fail the pending claim and cancel any chained image claim that
    // was waiting on it — a run that died must not leave rows that read as
    // "a job is fixing this" forever. Best-effort (the reconciler sweeps
    // anything this misses).
    if (payload.targetVersionId) {
      try {
        await scopedDb.framePromptVersions.markTerminal(
          payload.targetVersionId,
          'failed'
        );
        await scopedDb.frameVariants.cancelByDependency(
          payload.targetVersionId,
          'Upstream visual prompt generation failed'
        );
      } catch (dbErr) {
        logger.warn('[FramePromptWorkflow:cf] failed to mark claim failed', {
          err: dbErr,
        });
      }
    }
    // Surface the failure on the per-shot channel so an actively-viewing
    // client can clear its streaming state and toast. Best-effort.
    try {
      if (payload.emitStreaming && payload.shotId) {
        await getShotPromptChannel(payload.shotId).emit('shotPrompt.failed', {
          promptType: 'visual',
          error,
        });
      }
    } catch (emitErr) {
      logger.warn('[FramePromptWorkflow:cf] failed to emit failure', {
        err: emitErr,
      });
    }
  }
}
