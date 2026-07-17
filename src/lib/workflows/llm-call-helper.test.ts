import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { WorkflowStep } from 'cloudflare:workers';

// Import real modules before vi.doMock so mocks can re-export the rest.
import * as tanstackAi from '@tanstack/ai';
import * as createAdapterModule from '@/lib/ai/create-adapter';
import * as promptsModule from '@/lib/prompts';
import * as realtimeModule from '@/lib/realtime';

const mockChat = vi.fn();
vi.doMock('@tanstack/ai', () => ({
  ...tanstackAi,
  chat: mockChat,
}));

vi.doMock('@/lib/ai/create-adapter', () => ({
  ...createAdapterModule,
  createAdapter: () => ({ kind: 'text', name: 'mock' }),
  getPlatformLlmKey: () => ({
    key: 'test-key',
    source: 'platform' as const,
    via: 'openrouter' as const,
  }),
}));

vi.doMock('@/lib/prompts', () => ({
  ...promptsModule,
  getChatPrompt: () =>
    Promise.resolve({
      prompt: null,
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'user prompt' },
      ],
    }),
}));

const emitted: unknown[] = [];
vi.doMock('@/lib/realtime', () => ({
  ...realtimeModule,
  getShotPromptChannel: () => ({
    emit: (event: string, payload: unknown) => {
      emitted.push({ event, payload });
      return Promise.resolve();
    },
  }),
}));

const { durableStreamingLLMCallCf } = await import('./llm-call-helper');

// Minimal WorkflowStep: run every step body immediately, no retries.
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal WorkflowStep stub: the helper only uses `do`
const step = {
  do: (_name: string, fn: () => Promise<unknown>) => fn(),
} as unknown as WorkflowStep;

const schema = z.object({
  visual: z.object({ fullPrompt: z.string() }),
});

const callConfig = {
  name: 'visual-prompts',
  phase: { number: 3, name: 'Visual prompts' },
  promptName: 'phase/visual-prompt-scene-generation-chat',
  promptVariables: {},
  modelId: 'x-ai/grok-4.5' as const,
  responseSchema: schema,
};

const callContext = {
  sequenceId: '01TESTSEQUENCE0000000000',
  workflowRunId: 'wf-test',
  shotPromptStream: { shotId: 'shot-1', promptType: 'visual' as const },
};

describe('durableStreamingLLMCallCf structured-output.complete', () => {
  it('prefers the validated object from the complete event over accumulated text', async () => {
    const validObject = { visual: { fullPrompt: 'A clean shot' } };
    mockChat.mockReturnValue(
      (async function* () {
        // Deltas assemble to MALFORMED JSON (missing closing quote — the
        // Grok slip that motivated this): the event must win over the text.
        yield {
          type: 'TEXT_MESSAGE_CONTENT',
          delta: '{"visual":{"fullPrompt":"A clean shot',
        };
        yield { type: 'TEXT_MESSAGE_CONTENT', delta: '}}' };
        yield {
          type: 'CUSTOM',
          name: 'structured-output.complete',
          value: { object: validObject, raw: JSON.stringify(validObject) },
        };
      })()
    );

    const result = await durableStreamingLLMCallCf(
      step,
      callConfig,
      callContext
    );
    expect(result).toEqual(validObject);
  });

  it('falls back to accumulated text when no complete event arrives', async () => {
    const validJson = '{"visual":{"fullPrompt":"Fallback shot"}}';
    mockChat.mockReturnValue(
      (async function* () {
        yield { type: 'TEXT_MESSAGE_CONTENT', delta: validJson };
      })()
    );

    const result = await durableStreamingLLMCallCf(
      step,
      callConfig,
      callContext
    );
    expect(result).toEqual({ visual: { fullPrompt: 'Fallback shot' } });
  });

  it('still rejects when both the text is malformed and no event arrives', async () => {
    mockChat.mockReturnValue(
      (async function* () {
        yield {
          type: 'TEXT_MESSAGE_CONTENT',
          delta: '{"visual":{"fullPrompt":"broken}}',
        };
      })()
    );

    await expect(
      durableStreamingLLMCallCf(step, callConfig, callContext)
    ).rejects.toThrow();
  });
});
