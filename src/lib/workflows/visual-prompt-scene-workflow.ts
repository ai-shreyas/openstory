/**
 * Cloudflare Workflows port of `visualPromptSceneWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/visual-prompt-scene-workflow.ts`)
 * step for step — same step names, same control flow, same side effects. The
 * only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads payload from `event.payload` instead of `context.requestPayload`.
 *   - Inlines the LLM call logic from `durableStreamingLLMCall` because that
 *     helper is bound to QStash's `WorkflowContext`. The step names match
 *     the helper's exactly (`prepare-visual-prompts`, `visual-prompts` or
 *     `visual-prompts-stream`, `deduct-llm-credits-visual-prompts`) so a
 *     side-by-side comparison stays trivial. */

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
import { aiObservabilityMiddleware } from '@/lib/observability/ai-otel';
import { getLogger } from '@/lib/observability/logger';
import { getChatPrompt } from '@/lib/prompts';
import { getShotPromptChannel, getGenerationChannel } from '@/lib/realtime';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type { VisualPromptSceneWorkflowInput } from '@/lib/workflow/types';
import { chat, type TokenUsage } from '@tanstack/ai';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

const logger = getLogger(['openstory', 'workflow', 'visual-prompt-scene']);

type VisualPromptSceneResult = { sceneId: string; visual: VisualPrompt };

const PHASE = { number: 3, name: 'Writing image prompts…' } as const;
const STEP_NAME = 'visual-prompts';
const LOG_NAME = `phase-${PHASE.number}-${STEP_NAME}`;
const LOG_TAGS = [STEP_NAME, `phase-${PHASE.number}`, 'analysis'] as const;
const LOG_TAGS_STREAM = [...LOG_TAGS, 'stream'] as const;

export class VisualPromptSceneWorkflow extends OpenStoryWorkflowEntrypoint<VisualPromptSceneWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<VisualPromptSceneWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<VisualPromptSceneResult> {
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

    // Step 1: Prepare — resolve the chat prompt.
    const { messages } = await step.do(`prepare-${STEP_NAME}`, async () => {
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
      return { messages: msgs };
    });

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
          `[VisualPromptSceneWorkflow:cf] [LLM:${LOG_NAME}] Starting${
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
              middleware: [
                ...aiObservabilityMiddleware({
                  observationName: LOG_NAME,
                  tags: [...LOG_TAGS],
                  metadata: logMetadata,
                  sessionId: sequenceId,
                  userId,
                }),
                ...captureUsage,
              ],
              debug: false,
            });
            logger.info(
              `[VisualPromptSceneWorkflow:cf] [LLM:${LOG_NAME}] Call succeeded`
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
            outputSchema: visualPromptResultSchema,
            middleware: [
              ...aiObservabilityMiddleware({
                observationName: LOG_NAME,
                tags: [...LOG_TAGS_STREAM],
                metadata: logMetadata,
                sessionId: sequenceId,
                userId,
              }),
              ...captureUsage,
            ],
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
                `[VisualPromptSceneWorkflow:cf] [LLM:${LOG_NAME}] Streaming call RUN_ERROR`,
                { runError: runError.event }
              );
              throw new Error(formatRunErrorMessage(runError));
            }
          }
          await flushDelta();
          logger.info(
            `[VisualPromptSceneWorkflow:cf] [LLM:${LOG_NAME}] Streaming call succeeded`
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

      // `scene.continuity` already carries the scene's membership (from
      // scene-split), so we keep it as-is — no longer overwritten by an LLM
      // continuity output.
      const enrichedScene = {
        ...scene,
        prompts: {
          ...scene.prompts,
          visual: result.visual,
        },
      };

      // Hash the same scene-scoped `narrowed` context the LLM was given above,
      // so the stored hash equals the verify-time recompute by construction.
      const inputHash = await computeVisualPromptInputHash(narrowed);

      await step.do('save-visual-prompt-to-db', async () => {
        const previous = await scopedDb.shotPromptVariants.getLatest(
          shotId,
          'visual'
        );
        const source = previous ? 'regenerated' : 'ai-generated';

        // Clear `shot.imagePrompt` user-override when regenerating. The
        // override would otherwise mask the freshly regenerated prompt in
        // every downstream read (effective-prompt fallback chain), so a
        // regen-prompt click on a previously user-edited shot would do
        // nothing visible. The variant row above preserves the new prompt;
        // the user's prior override is still in the prompt-history sheet
        // and can be restored from there.
        await scopedDb.shots.update(shotId, {
          metadata: enrichedScene,
          imagePrompt: null,
        });

        await scopedDb.shotPromptVariants.write({
          shotId,
          promptType: 'visual',
          text: result.visual.fullPrompt,
          components: result.visual.components,
          source,
          inputHash,
          analysisModel: analysisModelId,
        });

        await getGenerationChannel(sequenceId).emit('generation.shot:updated', {
          shotId,
          updateType: 'visual-prompt',
          metadata: enrichedScene,
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
  }: {
    event: Readonly<WorkflowEvent<VisualPromptSceneWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): Promise<void> {
    const payload = event.payload;
    logger.error('[VisualPromptSceneWorkflow:cf] Failed', {
      workflowRunId: event.instanceId,
      error,
    });
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
      logger.warn('[VisualPromptSceneWorkflow:cf] failed to emit failure', {
        err: emitErr,
      });
    }
  }
}
