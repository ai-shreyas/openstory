/**
 * Default (non-Workers) implementation: awaits the flush inline. Used in
 * tests and local SSR where there's no Cloudflare execution context to defer
 * the work to.
 */

import { getPostHogClient } from '@/lib/posthog-server';
import { flushAIObservability } from './ai-otel';

export async function scheduleFlushAnalytics(): Promise<void> {
  await Promise.all([getPostHogClient()?.flush(), flushAIObservability()]);
}
