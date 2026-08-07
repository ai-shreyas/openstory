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
import { flushAnalytics } from './flush-analytics';

export async function scheduleFlushAnalytics(): Promise<void> {
  // `waitUntil` keeps the isolate alive until the promise resolves but does
  // not block the response. `flushAnalytics` never rejects (allSettled +
  // log), so a failed flush can't surface to the user — and can't settle
  // this promise while the other flush is still in flight.
  waitUntil(flushAnalytics());
}
