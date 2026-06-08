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
    getPostHogClient()?.flush(),
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
    });
  }
}
