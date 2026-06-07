import { usdToMicros, ZERO_MICROS } from '@/lib/billing/money';
import type { TokenUsage } from '@tanstack/ai';
import { convertWebSearchToolToAdapterFormat } from '@tanstack/ai-openrouter/tools';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// Import real exports before vi.doMock so they can be re-exported
import * as tanstackAi from '@tanstack/ai';

// Mock environment
vi.doMock('#env', () => ({
  getEnv: () => ({
    OPENROUTER_KEY: 'test-key',
    VITE_APP_URL: 'http://localhost:3000',
    VITE_APP_NAME: 'Test',
  }),
}));

// Mock @tanstack/ai — chat() is the only function callLLMStream uses
// Re-export all real exports so other test files aren't affected by incomplete mock
const mockChat = vi.fn();
vi.doMock('@tanstack/ai', () => ({
  ...tanstackAi,
  chat: mockChat,
}));

// Mock create-adapter to avoid real adapter creation
vi.doMock('./create-adapter', () => ({
  createAdapter: () => ({ kind: 'text', name: 'mock' }),
}));

// Mock the PostHog OTel middleware factory — observability hints are
// forwarded to it rather than to chat() metadata.
const mockAIObservabilityMiddleware = vi.fn(() => []);
vi.doMock('@/lib/observability/ai-otel', () => ({
  aiObservabilityMiddleware: mockAIObservabilityMiddleware,
}));

// Dynamic import so vi.doMock above is in effect when llm-client (and its
// `./create-adapter` import) resolves. Static imports are hoisted above
// vi.doMock and would bypass the mocks.
const { callLLM, callLLMStream, llmCostFromUsage } =
  await import('./llm-client');

const usage = (cost?: number): TokenUsage => ({
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cost,
});

describe('llm-client', () => {
  beforeEach(() => {
    mockChat.mockClear();
    mockAIObservabilityMiddleware.mockClear();
  });

  describe('callLLMStream', () => {
    it('handles split chunks correctly', async () => {
      mockChat.mockReturnValue(
        (async function* () {
          yield { type: 'TEXT_MESSAGE_CONTENT', delta: 'Hello' };
          yield { type: 'TEXT_MESSAGE_CONTENT', delta: ' ' };
          yield { type: 'TEXT_MESSAGE_CONTENT', delta: 'World' };
        })()
      );

      const generator = callLLMStream({
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'test' }],
      });

      let fullText = '';
      const chunks = [];

      for await (const chunk of generator) {
        if (!chunk.done) {
          fullText = chunk.accumulated;
          chunks.push(chunk.delta);
        }
      }

      expect(fullText).toBe('Hello World');
      expect(chunks).toEqual(['Hello', ' ', 'World']);
    });

    it('handles multiple lines in a single chunk', async () => {
      mockChat.mockReturnValue(
        (async function* () {
          yield { type: 'TEXT_MESSAGE_CONTENT', delta: 'A' };
          yield { type: 'TEXT_MESSAGE_CONTENT', delta: 'B' };
        })()
      );

      const generator = callLLMStream({
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'test' }],
      });

      let fullText = '';
      const chunks = [];

      for await (const chunk of generator) {
        if (!chunk.done) {
          fullText = chunk.accumulated;
          chunks.push(chunk.delta);
        }
      }

      expect(fullText).toBe('AB');
      expect(chunks).toEqual(['A', 'B']);
    });

    it('forwards userId and sessionId to the observability middleware', async () => {
      mockChat.mockReturnValue(
        (async function* () {
          yield { type: 'TEXT_MESSAGE_CONTENT', delta: 'ok' };
        })()
      );

      const generator = callLLMStream({
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'test' }],
        userId: 'user-123',
        sessionId: 'seq-456',
        observationName: 'unit-test',
      });

      for await (const _chunk of generator) {
        // drain
      }

      expect(mockChat).toHaveBeenCalledTimes(1);
      expect(mockAIObservabilityMiddleware).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-123',
          sessionId: 'seq-456',
          observationName: 'unit-test',
        })
      );
      const firstCall = mockChat.mock.calls[0];
      if (!firstCall) throw new Error('expected mockChat to have been called');
      // The factory's middleware array is passed through to chat().
      expect(firstCall[0].middleware).toEqual([]);
    });

    const drain = async (gen: AsyncIterable<unknown>) => {
      for await (const _chunk of gen) {
        // exhaust the generator
      }
    };

    it('handles stream errors', () => {
      mockChat.mockReturnValue(
        (async function* () {
          yield { type: 'TEXT_MESSAGE_CONTENT', delta: 'partial' };
          yield {
            type: 'RUN_ERROR',
            message: 'Connection lost',
          };
        })()
      );

      const generator = callLLMStream({
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'test' }],
      });

      return expect(drain(generator)).rejects.toThrow(
        'LLM stream error: Connection lost'
      );
    });

    it('preserves event.code in stream errors', () => {
      mockChat.mockReturnValue(
        (async function* () {
          yield {
            type: 'RUN_ERROR',
            message: 'Schema mismatch',
            code: 'schema-validation',
          };
        })()
      );

      const generator = callLLMStream({
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'test' }],
      });

      return expect(drain(generator)).rejects.toThrow(
        'LLM stream error [schema-validation]: Schema mismatch'
      );
    });

    it('surfaces event.code and event.model in stream errors', () => {
      mockChat.mockReturnValue(
        (async function* () {
          yield {
            type: 'RUN_ERROR',
            message: 'Provider returned error',
            code: 'provider-error',
            model: 'anthropic/claude-sonnet-4.6',
          };
        })()
      );

      const generator = callLLMStream({
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'test' }],
      });

      return expect(drain(generator)).rejects.toThrow(
        'LLM stream error [provider-error, model=anthropic/claude-sonnet-4.6]: Provider returned error'
      );
    });

    it('surfaces event.model even when code is absent', () => {
      mockChat.mockReturnValue(
        (async function* () {
          yield {
            type: 'RUN_ERROR',
            message: 'Provider returned error',
            model: 'anthropic/claude-sonnet-4.6',
          };
        })()
      );

      const generator = callLLMStream({
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'test' }],
      });

      return expect(drain(generator)).rejects.toThrow(
        'LLM stream error [model=anthropic/claude-sonnet-4.6]: Provider returned error'
      );
    });

    it('stringifies non-string RUN_ERROR.message', () => {
      mockChat.mockReturnValue(
        (async function* () {
          yield {
            type: 'RUN_ERROR',
            message: { reason: 'aborted', detail: 'user cancelled' },
          };
        })()
      );

      const generator = callLLMStream({
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'test' }],
      });

      return expect(drain(generator)).rejects.toThrow(/"reason":"aborted"/);
    });

    it('surfaces the provider error detail from rawEvent', () => {
      mockChat.mockReturnValue(
        (async function* () {
          yield {
            type: 'RUN_ERROR',
            message: 'Provider returned error',
            model: 'anthropic/claude-sonnet-4.6',
            rawEvent: {
              code: 400,
              message: 'Provider returned error',
              provider_name: 'Anthropic',
              raw: JSON.stringify({
                type: 'error',
                error: {
                  type: 'invalid_request_error',
                  message: 'output_config.format.schema: Invalid schema',
                },
              }),
            },
          };
        })()
      );

      const generator = callLLMStream({
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'test' }],
      });

      return expect(drain(generator)).rejects.toThrow(
        'LLM stream error [model=anthropic/claude-sonnet-4.6]: Provider returned error — provider=Anthropic output_config.format.schema: Invalid schema'
      );
    });

    describe('with responseSchema', () => {
      const schema = z.object({ greeting: z.string() });
      // A non-Anthropic structured-output model → native `outputSchema` path.
      const nativeModel = 'openai/gpt-5.5';

      it('yields parsed object on terminal chunk when structured-output.complete fires', async () => {
        mockChat.mockReturnValue(
          (async function* () {
            yield { type: 'TEXT_MESSAGE_CONTENT', delta: '{"greeting":' };
            yield { type: 'TEXT_MESSAGE_CONTENT', delta: '"hi"}' };
            yield {
              type: 'CUSTOM',
              name: 'structured-output.complete',
              value: { object: { greeting: 'hi' } },
            };
          })()
        );

        const generator = callLLMStream({
          model: nativeModel,
          messages: [{ role: 'user', content: 'test' }],
          responseSchema: schema,
        });

        const chunks = [];
        for await (const chunk of generator) {
          chunks.push(chunk);
        }

        const terminal = chunks.at(-1);
        if (!terminal || !terminal.done) {
          throw new Error('expected a terminal done:true chunk');
        }
        expect(terminal.parsed).toEqual({ greeting: 'hi' });

        // Non-terminal chunks have done:false and no parsed field
        const nonTerminal = chunks.slice(0, -1);
        expect(nonTerminal.every((c) => c.done === false)).toBe(true);
      });

      it('forwards outputSchema to chat()', async () => {
        mockChat.mockReturnValue(
          (async function* () {
            yield {
              type: 'CUSTOM',
              name: 'structured-output.complete',
              value: { object: { greeting: 'hi' } },
            };
          })()
        );

        const generator = callLLMStream({
          model: nativeModel,
          messages: [{ role: 'user', content: 'test' }],
          responseSchema: schema,
        });

        for await (const _chunk of generator) {
          // drain
        }

        expect(mockChat).toHaveBeenCalledTimes(1);
        const firstCall = mockChat.mock.calls[0];
        if (!firstCall)
          throw new Error('expected mockChat to have been called');
        expect(firstCall[0].outputSchema).toBe(schema);
      });

      it('yields parsed=undefined when stream ends without structured-output.complete', async () => {
        mockChat.mockReturnValue(
          (async function* () {
            yield { type: 'TEXT_MESSAGE_CONTENT', delta: 'plain text' };
          })()
        );

        const generator = callLLMStream({
          model: nativeModel,
          messages: [{ role: 'user', content: 'test' }],
          responseSchema: schema,
        });

        const chunks = [];
        for await (const chunk of generator) {
          chunks.push(chunk);
        }

        const terminal = chunks.at(-1);
        if (!terminal || !terminal.done) {
          throw new Error('expected a terminal done:true chunk');
        }
        expect(terminal.parsed).toBeUndefined();
      });

      it('uses the native outputSchema path for Anthropic models', async () => {
        // The json_object fallback is gone — Anthropic now goes through native
        // structured output like every other model (response schemas are kept
        // under Anthropic's strict-grammar union limits).
        mockChat.mockReturnValue(
          (async function* () {
            yield { type: 'TEXT_MESSAGE_CONTENT', delta: '{"greeting":' };
            yield { type: 'TEXT_MESSAGE_CONTENT', delta: '"hi"}' };
            yield {
              type: 'CUSTOM',
              name: 'structured-output.complete',
              value: { object: { greeting: 'hi' } },
            };
          })()
        );

        const chunks = [];
        for await (const chunk of callLLMStream({
          model: 'anthropic/claude-sonnet-4.6',
          messages: [{ role: 'user', content: 'test' }],
          responseSchema: schema,
        })) {
          chunks.push(chunk);
        }

        const callArgs = mockChat.mock.calls[0]?.[0];
        if (!callArgs) throw new Error('expected mockChat to have been called');
        // Native path: outputSchema is forwarded, no json_object responseFormat.
        expect(callArgs.outputSchema).toBe(schema);
        expect(callArgs.modelOptions.responseFormat).toBeUndefined();
        // `parsed` comes from the terminal structured-output.complete event.
        const terminal = chunks.at(-1);
        if (!terminal || !terminal.done) throw new Error('expected terminal');
        expect(terminal.parsed).toEqual({ greeting: 'hi' });
      });
    });

    describe('reasoning', () => {
      it('ignores REASONING_MESSAGE_CONTENT events (reasoning is not surfaced)', async () => {
        // Reasoning is enabled for quality, but its tokens are scratch work —
        // never accumulated into the answer or yielded to the caller.
        mockChat.mockReturnValue(
          (async function* () {
            yield { type: 'REASONING_MESSAGE_CONTENT', delta: 'let me think' };
            yield { type: 'TEXT_MESSAGE_CONTENT', delta: 'Hello' };
            yield { type: 'REASONING_MESSAGE_CONTENT', delta: ' more' };
            yield { type: 'TEXT_MESSAGE_CONTENT', delta: ' World' };
          })()
        );

        const answer: string[] = [];
        let finalAccumulated = '';
        for await (const chunk of callLLMStream({
          model: 'anthropic/claude-sonnet-4.6',
          messages: [{ role: 'user', content: 'test' }],
          reasoning: { enabled: true, effort: 'medium' },
        })) {
          if (chunk.delta) answer.push(chunk.delta);
          finalAccumulated = chunk.accumulated;
        }

        expect(answer).toEqual(['Hello', ' World']);
        expect(finalAccumulated).toBe('Hello World');
      });

      it('forwards the reasoning config to chat modelOptions', async () => {
        mockChat.mockReturnValue(
          (async function* () {
            yield { type: 'TEXT_MESSAGE_CONTENT', delta: 'ok' };
          })()
        );

        await drain(
          callLLMStream({
            model: 'anthropic/claude-sonnet-4.6',
            messages: [{ role: 'user', content: 'test' }],
            reasoning: { enabled: true, effort: 'medium' },
          })
        );

        const callArgs = mockChat.mock.calls[0]?.[0];
        if (!callArgs) throw new Error('expected mockChat to have been called');
        expect(callArgs.modelOptions.reasoning).toEqual({
          enabled: true,
          effort: 'medium',
        });
      });

      it('omits reasoning from modelOptions when not requested', async () => {
        mockChat.mockReturnValue(
          (async function* () {
            yield { type: 'TEXT_MESSAGE_CONTENT', delta: 'ok' };
          })()
        );

        await drain(
          callLLMStream({
            model: 'anthropic/claude-sonnet-4.6',
            messages: [{ role: 'user', content: 'test' }],
          })
        );

        const callArgs = mockChat.mock.calls[0]?.[0];
        if (!callArgs) throw new Error('expected mockChat to have been called');
        expect(callArgs.modelOptions.reasoning).toBeUndefined();
      });
    });

    describe('web search tool', () => {
      it('wires the OpenRouter web search server tool when webSearch is enabled', async () => {
        mockChat.mockReturnValue(
          (async function* () {
            yield { type: 'TEXT_MESSAGE_CONTENT', delta: 'ok' };
          })()
        );

        await drain(
          callLLMStream({
            model: 'anthropic/claude-sonnet-4.6',
            messages: [{ role: 'user', content: 'test' }],
            webSearch: true,
          })
        );

        expect(mockChat).toHaveBeenCalledTimes(1);
        const callArgs = mockChat.mock.calls[0]?.[0];
        if (!callArgs) throw new Error('expected mockChat to have been called');
        expect(callArgs.tools).toHaveLength(1);
        // Converting to the adapter wire format proves it's a genuine
        // webSearchTool() output and resolves to OpenRouter's server tool type.
        expect(
          convertWebSearchToolToAdapterFormat(callArgs.tools[0]).type
        ).toBe('openrouter:web_search');
      });

      it('omits tools entirely when webSearch is not requested', async () => {
        mockChat.mockReturnValue(
          (async function* () {
            yield { type: 'TEXT_MESSAGE_CONTENT', delta: 'ok' };
          })()
        );

        await drain(
          callLLMStream({
            model: 'anthropic/claude-sonnet-4.6',
            messages: [{ role: 'user', content: 'test' }],
          })
        );

        const callArgs = mockChat.mock.calls[0]?.[0];
        if (!callArgs) throw new Error('expected mockChat to have been called');
        expect(callArgs.tools).toBeUndefined();
      });
    });
  });

  // The non-streaming convenience wrapper drains callLLMStream, so it must share
  // the streaming path's error handling rather than calling chat({ stream:false
  // }) directly (whose streamToText collector ignores RUN_ERROR).
  describe('callLLM', () => {
    beforeEach(() => {
      mockChat.mockClear();
    });

    it('accumulates text deltas into the resolved string', async () => {
      mockChat.mockReturnValue(
        (async function* () {
          yield { type: 'TEXT_MESSAGE_CONTENT', delta: 'Hello ' };
          yield { type: 'TEXT_MESSAGE_CONTENT', delta: 'world' };
        })()
      );

      const result = await callLLM({
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'test' }],
      });

      expect(result).toBe('Hello world');
    });

    // Regression (#718): the old non-streaming path used chat({ stream: false }),
    // whose streamToText collector ignores RUN_ERROR — so a 402 (out of credits)
    // / 429 resolved to '' and resurfaced downstream as a bogus "empty
    // completion" / JSON-parse failure. It must now throw.
    it('throws on RUN_ERROR instead of resolving to an empty string', () => {
      mockChat.mockReturnValue(
        (async function* () {
          yield {
            type: 'RUN_ERROR',
            message:
              'Insufficient credits. Add more using https://openrouter.ai/settings/credits',
            code: '402',
            model: 'anthropic/claude-sonnet-4.6',
          };
        })()
      );

      return expect(
        callLLM({
          model: 'anthropic/claude-sonnet-4.6',
          messages: [{ role: 'user', content: 'test' }],
        })
      ).rejects.toThrow(/Insufficient credits/);
    });

    it('returns the validated object on the responseSchema path', async () => {
      const schema = z.object({ greeting: z.string() });
      mockChat.mockReturnValue(
        (async function* () {
          yield {
            type: 'CUSTOM',
            name: 'structured-output.complete',
            value: { object: { greeting: 'hi' } },
          };
        })()
      );

      const result = await callLLM({
        model: 'openai/gpt-5.5',
        messages: [{ role: 'user', content: 'test' }],
        responseSchema: schema,
      });

      expect(result).toEqual({ greeting: 'hi' });
    });

    it('throws when a structured call ends without a validated object', () => {
      const schema = z.object({ greeting: z.string() });
      mockChat.mockReturnValue(
        (async function* () {
          yield { type: 'TEXT_MESSAGE_CONTENT', delta: 'no schema event' };
        })()
      );

      return expect(
        callLLM({
          model: 'openai/gpt-5.5',
          messages: [{ role: 'user', content: 'test' }],
          responseSchema: schema,
        })
      ).rejects.toThrow(/no validated object/);
    });
  });

  describe('llmCostFromUsage', () => {
    it('charges the provider-reported cost (USD → micros)', () => {
      expect(llmCostFromUsage(usage(0.0123), 'model')).toBe(
        usdToMicros(0.0123)
      );
    });

    it('charges nothing when usage or cost is missing / non-finite', () => {
      expect(llmCostFromUsage(undefined, 'model')).toBe(ZERO_MICROS);
      expect(llmCostFromUsage(usage(undefined), 'model')).toBe(ZERO_MICROS);
      expect(llmCostFromUsage(usage(Number.NaN), 'model')).toBe(ZERO_MICROS);
    });

    it('treats explicit zero cost as zero', () => {
      expect(llmCostFromUsage(usage(0), 'model')).toBe(ZERO_MICROS);
    });
  });
});
