/**
 * PostHog LLM analytics via OpenTelemetry.
 *
 * `chat()` calls pass `aiObservabilityMiddleware(...)` so TanStack AI's
 * `otelMiddleware` emits `gen_ai.*` semconv spans — a root span per `chat()`
 * call plus one span per agent iteration carrying token usage and (via
 * `captureContent`) the input/output messages. Spans are exported to
 * PostHog's OTLP AI endpoint (`/i/v0/ai/otel`), which converts `gen_ai.*`
 * spans into `$ai_generation` / `$ai_span` events server-side.
 *
 * The exporter wiring mirrors `PostHogSpanProcessor` from `@posthog/ai/otel`
 * — vendored here because `@posthog/ai` hard-depends on the OpenAI /
 * Anthropic / Google / LangChain SDKs, which we don't want in the tree.
 *
 * User attribution is per-span: PostHog resolves `distinct_id` from the
 * `posthog.distinct_id` span attribute before falling back to resource
 * attributes (posthog/rust/capture/src/otel/identity.rs), so a single
 * isolate can attribute generations to many users. All other span
 * attributes pass through as event properties, which is how
 * `$ai_session_id`, `$ai_span_name`, and `$ai_tags` are set.
 */

import type {
  AttributeValue,
  Histogram,
  Meter,
  Tracer,
} from '@opentelemetry/api';
import {
  diag,
  DiagLogLevel,
  SpanKind,
  SpanStatusCode,
} from '@opentelemetry/api';
import {
  AggregationTemporalityPreference,
  OTLPMetricExporter,
} from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { ChatMiddleware, GenerationMiddleware } from '@tanstack/ai';
import { otelMiddleware } from '@tanstack/ai/middlewares/otel';
import { createServerOnlyFn } from '@tanstack/react-start';
import { microsToUsd, type Microdollars } from '@/lib/billing/money';
import { getLogger, toErrorPayload } from './logger';

const logger = getLogger(['openstory', 'observability', 'ai-otel']);

const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';
const SERVICE_NAME = 'openstory';

/**
 * Metrics export interval. Cloudflare isolates don't reliably run timers
 * between requests, so the periodic reader is not what gets data out —
 * `flushAIObservability()` is (see flush-scheduler + base-workflow). The
 * interval is set high so the timer is effectively a backstop rather than a
 * second, redundant export path.
 */
const METRIC_EXPORT_INTERVAL_MS = 300_000;

/**
 * Route the OTel SDK's internal diagnostics into our logger.
 *
 * This is the ONLY way most export failures become visible.
 * `MeterProvider.forceFlush()` bottoms out in
 * `PeriodicExportingMetricReader._runOnce()`, which catches every export
 * error into `globalErrorHandler` and resolves normally — so
 * `flushAIObservability` below cannot observe it, and a permanently broken
 * metrics exporter (rotated token, 401 on /i/v1/metrics) is otherwise
 * indistinguishable from a healthy one. The default `globalErrorHandler`
 * forwards to `diag.error`, and `diag` drops everything on the floor until a
 * logger is registered. The `BatchSpanProcessor`'s own timer-driven exports —
 * the designated backstop for hibernated workflows — report the same way.
 *
 * Registered inside the server-only telemetry factory rather than
 * `configureLogging()` because that runs in the browser too, and this pulls
 * OTel into whatever bundle it lands in.
 */
function bridgeOtelDiagnostics(): void {
  diag.setLogger(
    {
      error: (message, ...args) => logger.error(message, { args }),
      warn: (message, ...args) => logger.warn(message, { args }),
      info: () => {},
      debug: () => {},
      verbose: () => {},
    },
    DiagLogLevel.WARN
  );
}

type Telemetry = {
  tracer: Tracer;
  meter: Meter;
  /**
   * Same instrument `otelMiddleware` creates for in-call generations, so the
   * spans `recordMediaGenerationSpan` emits contribute to one series rather
   * than leaving a hole where media used to report.
   */
  mediaDurationHistogram: Histogram;
  traceProvider: BasicTracerProvider;
  meterProvider: MeterProvider;
};

let telemetry: Telemetry | null | undefined;

/**
 * Lazily build the tracer + meter providers exporting to PostHog. Returns
 * null (and stays null) when PostHog is not configured. Wrapped in
 * `createServerOnlyFn` so the OTel exporters never land in a client chunk.
 *
 * Traces and metrics go to *different* PostHog endpoints: spans to the AI
 * endpoint (`/i/v0/ai/otel`, which converts `gen_ai.*` spans into
 * `$ai_generation`), metric points to the general OTLP metrics endpoint
 * (`/i/v1/metrics`). Same project token authenticates both.
 */
const getAITelemetry = createServerOnlyFn((): Telemetry | null => {
  if (telemetry === undefined) {
    const projectToken =
      process.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN ||
      import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN;

    if (projectToken) {
      try {
        bridgeOtelDiagnostics();
        const host =
          process.env.VITE_PUBLIC_POSTHOG_HOST ||
          import.meta.env.VITE_PUBLIC_POSTHOG_HOST ||
          DEFAULT_POSTHOG_HOST;
        const origin = new URL(host).origin;
        const headers = { Authorization: `Bearer ${projectToken}` };

        const traceProvider = new BasicTracerProvider({
          resource: resourceFromAttributes({ 'service.name': SERVICE_NAME }),
          spanProcessors: [
            new BatchSpanProcessor(
              new OTLPTraceExporter({
                url: `${origin}/i/v0/ai/otel`,
                headers,
              })
            ),
          ],
        });

        const meterProvider = new MeterProvider({
          resource: resourceFromAttributes({ 'service.name': SERVICE_NAME }),
          readers: [
            new PeriodicExportingMetricReader({
              exportIntervalMillis: METRIC_EXPORT_INTERVAL_MS,
              exporter: new OTLPMetricExporter({
                url: `${origin}/i/v1/metrics`,
                headers,
                // DELTA, not the SDK default of CUMULATIVE. A cumulative
                // histogram reports a running total per process, but every
                // Cloudflare isolate is a fresh short-lived process that
                // would restart its counts at zero — so the series would be
                // a sawtooth that sums wrong. Delta reports only what this
                // isolate observed, which composes correctly across them.
                temporalityPreference: AggregationTemporalityPreference.DELTA,
              }),
            }),
          ],
        });

        const meter = meterProvider.getMeter(SERVICE_NAME);
        telemetry = {
          tracer: traceProvider.getTracer(SERVICE_NAME),
          meter,
          // Name/unit/description match otelMiddleware's instrument exactly —
          // a mismatch would split the series in two.
          mediaDurationHistogram: meter.createHistogram(
            'gen_ai.client.operation.duration',
            { description: 'GenAI client operation duration', unit: 's' }
          ),
          traceProvider,
          meterProvider,
        };
      } catch (error) {
        // Bad config (e.g. a malformed VITE_PUBLIC_POSTHOG_HOST) must
        // disable analytics, not fail the chat() call this factory runs in.
        // Cache the failure so it isn't re-thrown on every call.
        telemetry = null;
        logger.error('PostHog LLM analytics disabled: invalid config', {
          err: toErrorPayload(error),
        });
      }
    } else {
      telemetry = null;
      logger.warn(
        'PostHog LLM analytics disabled — VITE_PUBLIC_POSTHOG_PROJECT_TOKEN unset'
      );
    }
  }
  return telemetry ?? null;
});

export type AIObservabilityMeta = {
  /** Observation name shown in PostHog ($ai_span_name) */
  observationName?: string;
  /** Tags for PostHog filtering ($ai_tags) */
  tags?: string[];
  /** Extra properties passed through onto the PostHog events */
  metadata?: Record<string, unknown>;
  /** Session id for PostHog trace grouping (typically sequenceId) */
  sessionId?: string;
  /** User id — becomes the PostHog distinct_id of the generation events */
  userId?: string;
};

function buildAttributes(
  meta: AIObservabilityMeta
): Record<string, AttributeValue> {
  const attrs: Record<string, AttributeValue> = {};
  // Caller metadata is written FIRST so the reserved keys below always win.
  // The other order lets `metadata: { 'posthog.distinct_id': … }` silently
  // re-attribute a generation to a different user.
  for (const [key, value] of Object.entries(meta.metadata ?? {})) {
    if (value === undefined || value === null) continue;
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      attrs[key] = value;
    } else {
      attrs[key] = JSON.stringify(value);
    }
  }
  if (meta.userId) attrs['posthog.distinct_id'] = meta.userId;
  if (meta.sessionId) attrs['$ai_session_id'] = meta.sessionId;
  if (meta.observationName) attrs['$ai_span_name'] = meta.observationName;
  if (meta.tags?.length) attrs['$ai_tags'] = meta.tags;
  return attrs;
}

/**
 * Build the middleware array for a `chat()` or media (`generateImage` /
 * `generateAudio` / `generateVideo`) call. `otelMiddleware` returns a value
 * satisfying both `ChatMiddleware` and `GenerationMiddleware`, so the same
 * array can be spread into either activity. Returns `[]` when PostHog is not
 * configured so call sites can spread it unconditionally.
 */
export function aiObservabilityMiddleware(
  meta: AIObservabilityMeta = {}
): Array<ChatMiddleware & GenerationMiddleware> {
  const active = getAITelemetry();
  if (!active) return [];
  const { observationName } = meta;
  return [
    otelMiddleware({
      tracer: active.tracer,
      // Emits `gen_ai.client.operation.duration` and
      // `gen_ai.client.token.usage` histograms. Their attributes are a fixed
      // low-cardinality set the middleware controls (system, operation,
      // model, token type) — `attributeEnricher` below applies to spans
      // only, so per-user `posthog.distinct_id` never reaches a metric
      // series. That matters: PostHog bills and guards metrics per series.
      meter: active.meter,
      captureContent: true,
      ...(observationName && {
        spanNameFormatter: (info) =>
          info.kind === 'iteration'
            ? `${observationName} #${info.iteration}`
            : observationName,
      }),
      attributeEnricher: () => buildAttributes(meta),
    }),
  ];
}

export type MediaGenerationRecord = AIObservabilityMeta & {
  /** Model id as submitted to the provider. */
  model: string;
  /** `gen_ai.system` — the provider the request was billed by. */
  provider: string;
  /** Media activity, mapped to the `gen_ai.operation.name` semconv value. */
  activity: 'video' | 'image' | 'audio';
  /** Wall-clock duration of the whole generation, submit → result. */
  durationMs: number;
  /**
   * Final charge, once known. Becomes `gen_ai.usage.cost` (USD).
   *
   * Always OUR figure, priced from `model_pricing` in D1 — never the
   * provider's. fal's adapter reports billable *units* and nothing else, and
   * it can't do better: the dollar rate depends on whose key ran the job
   * (team BYOK vs platform) and on rates we bill-verify ourselves (#1069).
   */
  costMicros?: Microdollars;
  /** Provider-reported billable units for the completed job. */
  unitsBilled?: number;
  /** Request prompt, recorded as the span's input. */
  prompt?: string;
  /** Terminal media URL(s), recorded as the span's output. */
  outputUrl?: string | string[];
  /** Set on a failed generation — marks the span ERROR instead of OK. */
  errorType?: string;
};

const MEDIA_OPERATION_NAME = {
  video: 'video_generation',
  image: 'image_generation',
  audio: 'audio_generation',
} as const;

/**
 * Emit one span for a completed media generation, recorded by the caller
 * after the fact rather than by middleware around the adapter call.
 *
 * Every fal media surface needs this for one of two reasons:
 *
 *   - **Cost.** fal's adapter reports billable units, never dollars, and it
 *     can't do otherwise — the rate depends on whose key ran the job and on
 *     prices we bill-verify into `model_pricing` (#1069). Resolving it means
 *     an async D1 read that finishes AFTER `generateImage`/`generateAudio`
 *     return, by which point a middleware span has already closed. So the
 *     span has to be emitted here, where our own cost is known.
 *   - **Async completion.** `generateVideo()` returns as soon as fal accepts
 *     the job; the video is collected by polling in later workflow steps. A
 *     middleware span there would time the queue submit and carry no cost,
 *     duration, or output at all.
 *
 * `durationMs` is supplied by the caller (not measured here) so the span
 * covers the generation rather than this bookkeeping call — the span is
 * backdated by it.
 *
 * Attributes mirror what `otelMiddleware` sets for an in-call generation
 * (`gen_ai.system` / `operation.name` / `request.model` + `usageAttributes`),
 * and the duration histogram is the same instrument, so PostHog sees one
 * consistent `$ai_generation` shape and one metric series either way.
 */
export function recordMediaGenerationSpan(record: MediaGenerationRecord): void {
  const active = getAITelemetry();
  if (!active) return;

  const operationName = MEDIA_OPERATION_NAME[record.activity];
  const endTime = Date.now();
  const span = active.tracer.startSpan(
    record.observationName ?? `${operationName} ${record.model}`,
    {
      kind: SpanKind.CLIENT,
      startTime: endTime - record.durationMs,
      attributes: {
        'gen_ai.system': record.provider,
        'gen_ai.operation.name': operationName,
        'gen_ai.request.model': record.model,
        ...(record.costMicros !== undefined && {
          'gen_ai.usage.cost': microsToUsd(record.costMicros),
        }),
        ...(record.unitsBilled !== undefined && {
          'tanstack.ai.usage.units_billed': record.unitsBilled,
        }),
        ...(record.prompt && { 'gen_ai.input.messages': record.prompt }),
        ...(record.outputUrl && {
          'gen_ai.output.messages': Array.isArray(record.outputUrl)
            ? record.outputUrl.join('\n')
            : record.outputUrl,
        }),
        ...(record.errorType && { 'error.type': record.errorType }),
      },
    }
  );
  span.setAttributes(buildAttributes(record));
  span.setStatus(
    record.errorType
      ? { code: SpanStatusCode.ERROR, message: record.errorType }
      : { code: SpanStatusCode.OK }
  );
  span.end(endTime);

  // Attributes deliberately exclude the per-user ones — PostHog bills and
  // guards metrics per series, so `posthog.distinct_id` must never reach one.
  active.mediaDurationHistogram.record(record.durationMs / 1000, {
    'gen_ai.system': record.provider,
    'gen_ai.operation.name': operationName,
    'gen_ai.request.model': record.model,
    ...(record.errorType && { 'error.type': record.errorType }),
  });
}

/**
 * Force-flush pending AI spans and metric points to PostHog. Call before a
 * serverless isolate suspends (see flush-scheduler + base-workflow).
 *
 * `allSettled` so a failing span export can't strand the metric export, or
 * vice versa — and a rejection is rethrown so `flushAnalytics` logs it.
 *
 * Only the trace side actually reports that way. `MeterProvider.forceFlush()`
 * swallows export errors into the OTel global error handler and resolves —
 * `bridgeOtelDiagnostics` above is what makes those visible.
 */
export async function flushAIObservability(): Promise<void> {
  if (!telemetry) return;
  const results = await Promise.allSettled([
    telemetry.traceProvider.forceFlush(),
    telemetry.meterProvider.forceFlush(),
  ]);
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length > 0) {
    throw new AggregateError(
      failed.map((r) => r.reason),
      'AI observability flush failed'
    );
  }
}
