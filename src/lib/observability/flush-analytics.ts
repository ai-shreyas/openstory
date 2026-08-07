/**
 * Flushes all buffered analytics: PostHog events + AI OTel spans. Shared by
 * both `#flush-scheduler` variants.
 *
 * Uses `allSettled` (not `all`) so one flush rejecting can't abandon the
 * other mid-flight, and never rejects itself — analytics failures are
 * swallowed-but-logged so they can't clobber a handler's result via the
 * middleware `finally` that awaits the scheduler.
 */

import { getPostHogClient } from '@/lib/posthog-server';
import { flushAIObservability } from './ai-otel';
import { getLogger, toErrorPayload } from './logger';

const logger = getLogger(['openstory', 'observability', 'flush-scheduler']);

export async function flushAnalytics(): Promise<void> {
  const [events, spans] = await Promise.allSettled([
    // Wrapped in an async thunk so `allSettled` also covers a SYNCHRONOUS
    // throw out of `getPostHogClient()` — it constructs `new PostHog(...)` on
    // first call, and a throw there would escape the array literal, rejecting
    // this function. `base-workflow` awaits it in a `finally` on the throw
    // path, so that rejection would replace the workflow's real error.
    (async () => getPostHogClient()?.flush())(),
    flushAIObservability(),
  ]);
  if (events.status === 'rejected') {
    logger.error('PostHog event flush failed', {
      err: toErrorPayload(events.reason),
    });
  }
  if (spans.status === 'rejected') {
    logger.error('AI OTel span flush failed', {
      err: toErrorPayload(spans.reason),
      // `flushAIObservability` rejects with an AggregateError, whose causes
      // live on `.errors` — and `toErrorPayload` only walks `.cause`. Without
      // this the log says "AI observability flush failed" and nothing about
      // WHY, which is the whole point of not swallowing it.
      ...(spans.reason instanceof AggregateError && {
        reasons: spans.reason.errors.map((e) => toErrorPayload(e)),
      }),
    });
  }
}
