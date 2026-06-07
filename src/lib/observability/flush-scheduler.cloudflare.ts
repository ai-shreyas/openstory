/**
 * Cloudflare Workers implementation: schedules the flush via
 * `cloudflare:workers` `waitUntil()` so it runs after the response is sent
 * instead of blocking the user-visible request duration.
 *
 * See issue #770 / PR #765: previously every serverFn awaited the flush
 * synchronously in middleware, which added the export POST's latency to
 * every request's wall-clock time.
 */

import { waitUntil } from 'cloudflare:workers';
import { getPostHogClient } from '@/lib/posthog-server';
import { flushAIObservability } from './ai-otel';
import { getLogger } from './logger';

const logger = getLogger(['openstory', 'observability', 'flush-scheduler']);

export async function scheduleFlushAnalytics(): Promise<void> {
  // `waitUntil` keeps the isolate alive until the promise resolves but does
  // not block the response. If the flush throws, swallow + log so we don't
  // surface analytics failures to the user.
  waitUntil(
    Promise.all([getPostHogClient()?.flush(), flushAIObservability()]).catch(
      (err: unknown) => {
        logger.error('background analytics flush failed', { err });
      }
    )
  );
}
