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

import type { AttributeValue, Meter, Tracer } from '@opentelemetry/api';
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

type Telemetry = {
  tracer: Tracer;
  meter: Meter;
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
        const host =
          process.env.VITE_PUBLIC_POSTHOG_HOST ||
          import.meta.env.VITE_PUBLIC_POSTHOG_HOST ||
          DEFAULT_POSTHOG_HOST;
        const origin = new URL(host).origin;
        const headers = { Authorization: `Bearer ${projectToken}` };

        const traceProvider = new BasicTracerProvider({
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

        telemetry = {
          tracer: traceProvider.getTracer(SERVICE_NAME),
          meter: meterProvider.getMeter(SERVICE_NAME),
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
  if (meta.userId) attrs['posthog.distinct_id'] = meta.userId;
  if (meta.sessionId) attrs['$ai_session_id'] = meta.sessionId;
  if (meta.observationName) attrs['$ai_span_name'] = meta.observationName;
  if (meta.tags?.length) attrs['$ai_tags'] = meta.tags;
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

/**
 * Force-flush pending AI spans and metric points to PostHog. Call before a
 * serverless isolate suspends (see flush-scheduler + base-workflow).
 *
 * `allSettled` so a failing span export can't strand the metric export, or
 * vice versa — but any rejection is then rethrown so `flushAnalytics` still
 * logs it. Swallowing here would make a permanently broken exporter look
 * exactly like a healthy one.
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
