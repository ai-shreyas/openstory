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
import type { Attributes, SpanOptions, SpanStatus } from '@opentelemetry/api';
import { SpanStatusCode } from '@opentelemetry/api';
import { micros } from '@/lib/billing/money';
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

// Stub the tracer provider so `recordMediaGenerationSpan` — which builds its
// span directly rather than through `otelMiddleware` — can be inspected.
const mockSpan = {
  setAttributes: vi.fn((_attributes: Attributes) => {}),
  setStatus: vi.fn((_status: SpanStatus) => {}),
  end: vi.fn((_endTime?: number) => {}),
};
const mockStartSpan = vi.fn(
  (_name: string, _options?: SpanOptions) => mockSpan
);
vi.doMock('@opentelemetry/sdk-trace-base', () => ({
  BasicTracerProvider: class {
    getTracer() {
      return { startSpan: mockStartSpan };
    }
    forceFlush() {
      return Promise.resolve();
    }
  },
  BatchSpanProcessor: class {},
}));

// Same for the meter, so the media duration histogram can be inspected.
const mockRecordHistogram = vi.fn(
  (_value: number, _attributes: Attributes) => {}
);
vi.doMock('@opentelemetry/sdk-metrics', () => ({
  MeterProvider: class {
    getMeter() {
      return {
        createHistogram: () => ({ record: mockRecordHistogram }),
      };
    }
    forceFlush() {
      return Promise.resolve();
    }
  },
  PeriodicExportingMetricReader: class {},
}));

// The enricher/formatter ignore ctx, so an inert stub is sufficient. The
// capability-DI members (`capabilities`/`get`/`getOptional`/`provide`) are
// unused here and back a class with private state that no literal can satisfy,
// so we assert the documented fields to the context type.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- inert test stub; capability-DI members are unused and unconstructable from a literal
const middlewareCtx = {
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
  createId: (prefix: string) => `${prefix}-1`,
} as unknown as ChatMiddlewareContext;
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

  describe('metrics', () => {
    it('passes a meter so the gen_ai.client.* histograms are emitted', async () => {
      // Without `meter`, otelMiddleware emits spans only and silently drops
      // gen_ai.client.operation.duration / gen_ai.client.token.usage.
      const { aiObservabilityMiddleware } = await importAiOtel({
        token: 'phc_test',
      });

      aiObservabilityMiddleware({ userId: 'user-1' });

      expect(capturedOptions().meter).toBeDefined();
    });

    it('does not create a meter when PostHog is unconfigured', async () => {
      // The meter provider owns an exporter and a periodic timer; building
      // one when there is nowhere to send data would leave a timer running
      // in every isolate for no reason.
      const { aiObservabilityMiddleware } = await importAiOtel();

      expect(aiObservabilityMiddleware({ userId: 'user-1' })).toEqual([]);
      expect(mockOtelMiddleware).not.toHaveBeenCalled();
    });

    it('flushing is a no-op when PostHog is unconfigured', async () => {
      const { flushAIObservability } = await importAiOtel();

      await expect(flushAIObservability()).resolves.toBeUndefined();
    });
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

    it('does not let metadata overwrite the reserved attribution keys', async () => {
      // Metadata is caller-supplied; if it were written last, a stray
      // `posthog.distinct_id` key would re-attribute the generation.
      const { aiObservabilityMiddleware } = await importAiOtel({
        token: 'phc_test',
      });

      aiObservabilityMiddleware({
        userId: 'user-1',
        sessionId: 'seq-1',
        metadata: {
          'posthog.distinct_id': 'attacker',
          $ai_session_id: 'other-session',
        },
      });

      const { attributeEnricher } = capturedOptions();
      if (!attributeEnricher) throw new Error('expected attributeEnricher');
      expect(attributeEnricher(chatSpanInfo())).toEqual({
        'posthog.distinct_id': 'user-1',
        $ai_session_id: 'seq-1',
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

/**
 * Every fal media generation reports through this rather than middleware:
 * cost is OURS (priced from D1 after the adapter returns, since fal reports
 * units not dollars), and video additionally completes by polling long after
 * `generateVideo()` returned.
 */
describe('recordMediaGenerationSpan', () => {
  const record = {
    model: 'kling-v2.5',
    provider: 'fal',
    activity: 'video' as const,
    durationMs: 42_000,
    costMicros: micros(350_000),
    unitsBilled: 5,
    prompt: 'a cat on a skateboard',
    outputUrl: 'https://cdn.test/video.mp4',
    observationName: 'motion',
    tags: ['motion'],
    userId: 'user-1',
    sessionId: 'seq-1',
    metadata: { shotId: 'shot-1' },
  };

  beforeEach(() => {
    mockStartSpan.mockClear();
    mockSpan.setAttributes.mockClear();
    mockSpan.setStatus.mockClear();
    mockSpan.end.mockClear();
    mockRecordHistogram.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is a no-op when PostHog is not configured', async () => {
    const { recordMediaGenerationSpan } = await importAiOtel();

    recordMediaGenerationSpan(record);

    expect(mockStartSpan).not.toHaveBeenCalled();
  });

  it('emits a gen_ai span carrying cost, units and output', async () => {
    const { recordMediaGenerationSpan } = await importAiOtel({
      token: 'phc_test',
    });

    recordMediaGenerationSpan(record);

    const [name, options] = mockStartSpan.mock.calls[0] ?? [];
    expect(name).toBe('motion');
    expect(options?.attributes).toEqual({
      'gen_ai.system': 'fal',
      'gen_ai.operation.name': 'video_generation',
      'gen_ai.request.model': 'kling-v2.5',
      // 350_000 microdollars → $0.35, priced from OUR model_pricing table.
      // Without this the generation lands in PostHog with no cost at all:
      // fal's adapter reports billable units and never dollars.
      'gen_ai.usage.cost': 0.35,
      'tanstack.ai.usage.units_billed': 5,
      'gen_ai.input.messages': 'a cat on a skateboard',
      'gen_ai.output.messages': 'https://cdn.test/video.mp4',
    });
    expect(mockSpan.setAttributes).toHaveBeenCalledWith({
      'posthog.distinct_id': 'user-1',
      $ai_session_id: 'seq-1',
      $ai_span_name: 'motion',
      $ai_tags: ['motion'],
      shotId: 'shot-1',
    });
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });

  it('backdates the span so its duration is the generation, not the bookkeeping call', async () => {
    const { recordMediaGenerationSpan } = await importAiOtel({
      token: 'phc_test',
    });

    recordMediaGenerationSpan(record);

    const [, options] = mockStartSpan.mock.calls[0] ?? [];
    const endTime = mockSpan.end.mock.calls[0]?.[0];
    if (typeof options?.startTime !== 'number' || typeof endTime !== 'number') {
      throw new Error('expected numeric startTime/endTime');
    }
    expect(endTime - options.startTime).toBe(42_000);
  });

  it('marks a failed generation ERROR and keeps cost off it', async () => {
    const { recordMediaGenerationSpan } = await importAiOtel({
      token: 'phc_test',
    });

    recordMediaGenerationSpan({
      model: 'kling-v2.5',
      provider: 'fal',
      activity: 'video',
      durationMs: 1_000,
      errorType: 'content flagged',
      userId: 'user-1',
    });

    const [, options] = mockStartSpan.mock.calls[0] ?? [];
    expect(options?.attributes).toMatchObject({
      'error.type': 'content flagged',
    });
    expect(options?.attributes).not.toHaveProperty('gen_ai.usage.cost');
    expect(mockSpan.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: 'content flagged',
    });
  });

  it('records the duration histogram without per-user attributes', async () => {
    // PostHog bills and guards metrics per series, so `posthog.distinct_id`
    // must never reach one — that would be a series per user.
    const { recordMediaGenerationSpan } = await importAiOtel({
      token: 'phc_test',
    });

    recordMediaGenerationSpan(record);

    expect(mockRecordHistogram).toHaveBeenCalledWith(42, {
      'gen_ai.system': 'fal',
      'gen_ai.operation.name': 'video_generation',
      'gen_ai.request.model': 'kling-v2.5',
    });
  });
});
