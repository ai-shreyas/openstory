/**
 * Default (non-Workers) implementation: awaits the flush inline. Used in
 * tests and local SSR where there's no Cloudflare execution context to defer
 * the work to. `flushAnalytics` never rejects, so awaiting it in a
 * middleware `finally` can't clobber the handler's result.
 */

import { flushAnalytics } from './flush-analytics';

export async function scheduleFlushAnalytics(): Promise<void> {
  await flushAnalytics();
}
