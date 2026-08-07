import { getAuth } from '@/lib/auth/config';
import { createFileRoute } from '@tanstack/react-router';
import { scheduleFlushAnalytics } from '#flush-scheduler';

/**
 * Better Auth's `user.create` / `session.create` hooks fire
 * `captureProductEvent` (`user_signed_up` / `user_signed_in`, #1088), and
 * that call is fire-and-forget. The posthog-node client is configured
 * `flushAt: 1, flushInterval: 0`, so the HTTP request leaves immediately —
 * but nothing holds the isolate open for it, and on Workers an in-flight
 * fetch is cancelled once the response is returned. Whether the event lands
 * is then a race against teardown: production recorded 36 `user_signed_in`
 * but none for four days, and only two `user_signed_up` ever.
 *
 * Server functions avoid this because their middleware schedules the flush
 * (`src/functions/middleware.ts`); this route has no middleware, so it
 * schedules its own. `scheduleFlushAnalytics` routes through `waitUntil` on
 * Workers, so the response is not delayed.
 */
async function handleAuthRequest(request: Request): Promise<Response> {
  const auth = getAuth();
  const response = await auth.handler(request);
  await scheduleFlushAnalytics();
  return response;
}

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: ({ request }) => handleAuthRequest(request),
      POST: ({ request }) => handleAuthRequest(request),
    },
  },
});
