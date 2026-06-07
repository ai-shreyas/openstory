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

import type { AttributeValue, Tracer } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { ChatMiddleware } from '@tanstack/ai';
import { otelMiddleware } from '@tanstack/ai/middlewares/otel';
import { createServerOnlyFn } from '@tanstack/react-start';

const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

let provider: BasicTracerProvider | null | undefined;

/**
 * Lazily build the tracer provider exporting to PostHog. Returns null (and
 * stays null) when PostHog is not configured. Wrapped in
 * `createServerOnlyFn` so the OTel exporter never lands in a client chunk.
 */
const getAITracer = createServerOnlyFn((): Tracer | null => {
  if (provider === undefined) {
    const projectToken =
      process.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN ||
      import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN;

    if (projectToken) {
      const host =
        process.env.VITE_PUBLIC_POSTHOG_HOST ||
        import.meta.env.VITE_PUBLIC_POSTHOG_HOST ||
        DEFAULT_POSTHOG_HOST;
      const exporter = new OTLPTraceExporter({
        url: `${new URL(host).origin}/i/v0/ai/otel`,
        headers: { Authorization: `Bearer ${projectToken}` },
      });
      provider = new BasicTracerProvider({
        spanProcessors: [new BatchSpanProcessor(exporter)],
      });
    } else {
      provider = null;
    }
  }
  return provider ? provider.getTracer('openstory') : null;
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
 * Build the middleware array for a `chat()` call. Returns `[]` when PostHog
 * is not configured so call sites can spread it unconditionally.
 */
export function aiObservabilityMiddleware(
  meta: AIObservabilityMeta = {}
): Array<ChatMiddleware> {
  const tracer = getAITracer();
  if (!tracer) return [];
  const { observationName } = meta;
  return [
    otelMiddleware({
      tracer,
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
 * Force-flush pending AI spans to PostHog. Call before a serverless isolate
 * suspends (see flush-scheduler).
 */
export async function flushAIObservability(): Promise<void> {
  if (provider) await provider.forceFlush();
}
