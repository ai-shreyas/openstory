/**
 * Tests for the PostHog AI OTel middleware factory. `otelMiddleware` is
 * mocked so the options ai-otel builds (attributeEnricher, spanNameFormatter)
 * can be captured and exercised directly — the attribute key strings are
 * load-bearing: a typo in `posthog.distinct_id` silently drops user
 * attribution from every $ai_generation event.
 */

import type { ChatMiddleware, ChatMiddlewareContext } from '@tanstack/ai';
import type {
  OtelMiddlewareOptions,
  OtelSpanInfo,
} from '@tanstack/ai/middlewares/otel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const otelMiddlewareReturn: ChatMiddleware = { name: 'mock-otel' };
const mockOtelMiddleware = vi.fn(
  (_options: OtelMiddlewareOptions): ChatMiddleware => otelMiddlewareReturn
);
vi.doMock('@tanstack/ai/middlewares/otel', () => ({
  otelMiddleware: mockOtelMiddleware,
}));

// createServerOnlyFn needs the Start server runtime — unwrap it in tests.
vi.doMock('@tanstack/react-start', () => ({
  createServerOnlyFn: <T>(fn: T) => fn,
}));

// The enricher/formatter ignore ctx, so an inert stub is sufficient.
const middlewareCtx: ChatMiddlewareContext = {
  requestId: 'req-1',
  streamId: 'stream-1',
  runId: 'run-1',
  threadId: 'thread-1',
  phase: 'beforeModel',
  iteration: 0,
  chunkIndex: 0,
  abort: () => {},
  context: undefined,
  defer: () => {},
  provider: 'test',
  model: 'test-model',
  source: 'server',
  streaming: true,
  systemPrompts: [],
  messageCount: 0,
  hasTools: false,
  currentMessageId: null,
  accumulatedContent: '',
  messages: [],
  createId: (prefix) => `${prefix}-1`,
};
const chatSpanInfo = (): OtelSpanInfo => ({ kind: 'chat', ctx: middlewareCtx });
const iterationSpanInfo = (iteration: number): OtelSpanInfo => ({
  kind: 'iteration',
  ctx: middlewareCtx,
  iteration,
});

/**
 * Fresh module instance per call — `provider` is memoized at module level,
 * so each test re-imports after stubbing env. Both env vars are always
 * stubbed (vi.stubEnv covers process.env AND import.meta.env) so values from
 * .env.local can't leak in.
 */
async function importAiOtel({
  token = '',
  host = '',
}: { token?: string; host?: string } = {}) {
  vi.resetModules();
  vi.stubEnv('VITE_PUBLIC_POSTHOG_PROJECT_TOKEN', token);
  vi.stubEnv('VITE_PUBLIC_POSTHOG_HOST', host);
  return await import('./ai-otel');
}

function capturedOptions(): OtelMiddlewareOptions {
  const options = mockOtelMiddleware.mock.calls[0]?.[0];
  if (!options) throw new Error('expected otelMiddleware to have been called');
  return options;
}

describe('aiObservabilityMiddleware', () => {
  beforeEach(() => {
    mockOtelMiddleware.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns [] when PostHog is not configured', async () => {
    const { aiObservabilityMiddleware } = await importAiOtel();

    expect(aiObservabilityMiddleware({ userId: 'user-1' })).toEqual([]);
    expect(mockOtelMiddleware).not.toHaveBeenCalled();
  });

  it('returns the otel middleware with content capture when configured', async () => {
    const { aiObservabilityMiddleware } = await importAiOtel({
      token: 'phc_test',
    });

    expect(aiObservabilityMiddleware({ userId: 'user-1' })).toEqual([
      otelMiddlewareReturn,
    ]);
    expect(capturedOptions().captureContent).toBe(true);
  });

  it('disables analytics instead of throwing when the host is malformed', async () => {
    // Regression: `new URL('us.i.posthog.com')` (no scheme) throws. That must
    // disable analytics — not fail the chat() call — and must be cached so
    // subsequent calls don't re-throw either.
    const { aiObservabilityMiddleware } = await importAiOtel({
      token: 'phc_test',
      host: 'us.i.posthog.com',
    });

    expect(aiObservabilityMiddleware({ userId: 'user-1' })).toEqual([]);
    expect(aiObservabilityMiddleware({ userId: 'user-1' })).toEqual([]);
    expect(mockOtelMiddleware).not.toHaveBeenCalled();
  });

  describe('attribute enrichment', () => {
    it('maps meta onto the PostHog span attribute keys', async () => {
      const { aiObservabilityMiddleware } = await importAiOtel({
        token: 'phc_test',
      });

      aiObservabilityMiddleware({
        userId: 'user-1',
        sessionId: 'seq-1',
        observationName: 'scene-analysis',
        tags: ['workflow'],
        metadata: {
          sceneCount: 3,
          modelName: 'test-model',
          streaming: true,
          nested: { a: 1 },
          skippedNull: null,
          skippedUndefined: undefined,
        },
      });

      const { attributeEnricher } = capturedOptions();
      if (!attributeEnricher) throw new Error('expected attributeEnricher');
      expect(attributeEnricher(chatSpanInfo())).toEqual({
        'posthog.distinct_id': 'user-1',
        $ai_session_id: 'seq-1',
        $ai_span_name: 'scene-analysis',
        $ai_tags: ['workflow'],
        sceneCount: 3,
        modelName: 'test-model',
        streaming: true,
        nested: JSON.stringify({ a: 1 }),
      });
    });

    it('omits attributes for absent meta and empty tags', async () => {
      const { aiObservabilityMiddleware } = await importAiOtel({
        token: 'phc_test',
      });

      aiObservabilityMiddleware({ tags: [] });

      const { attributeEnricher } = capturedOptions();
      if (!attributeEnricher) throw new Error('expected attributeEnricher');
      expect(attributeEnricher(chatSpanInfo())).toEqual({});
    });
  });

  describe('span naming', () => {
    it('names iteration spans "name #n" and other spans "name"', async () => {
      const { aiObservabilityMiddleware } = await importAiOtel({
        token: 'phc_test',
      });

      aiObservabilityMiddleware({ observationName: 'scene-analysis' });

      const { spanNameFormatter } = capturedOptions();
      if (!spanNameFormatter) throw new Error('expected spanNameFormatter');
      expect(spanNameFormatter(iterationSpanInfo(2))).toBe('scene-analysis #2');
      expect(spanNameFormatter(chatSpanInfo())).toBe('scene-analysis');
    });

    it('keeps default span names when no observationName is given', async () => {
      const { aiObservabilityMiddleware } = await importAiOtel({
        token: 'phc_test',
      });

      aiObservabilityMiddleware({ userId: 'user-1' });

      expect(capturedOptions().spanNameFormatter).toBeUndefined();
    });
  });
});
