/**
 * `flushAnalytics` must never reject. Three call sites depend on it:
 * `base-workflow`'s `finally` (which runs while a real error is propagating —
 * a rejection here would replace it), the Cloudflare `waitUntil` scheduler,
 * and both `finally` blocks in the server-fn / request middleware.
 */

import { describe, expect, it, vi } from 'vitest';

const flushAIObservability = vi.fn(() => Promise.resolve());
vi.doMock('./ai-otel', () => ({ flushAIObservability }));

const postHogFlush = vi.fn(() => Promise.resolve());
const getPostHogClient = vi.fn((): { flush: () => Promise<void> } | null => ({
  flush: postHogFlush,
}));
vi.doMock('@/lib/posthog-server', () => ({ getPostHogClient }));

const { flushAnalytics } = await import('./flush-analytics');

describe('flushAnalytics', () => {
  it('flushes both events and spans', async () => {
    await expect(flushAnalytics()).resolves.toBeUndefined();

    expect(postHogFlush).toHaveBeenCalledTimes(1);
    expect(flushAIObservability).toHaveBeenCalledTimes(1);
  });

  it('resolves when both flushes reject', async () => {
    postHogFlush.mockRejectedValueOnce(new Error('posthog down'));
    flushAIObservability.mockRejectedValueOnce(new Error('otlp 401'));

    await expect(flushAnalytics()).resolves.toBeUndefined();
  });

  it('still runs the span flush when the event flush rejects', async () => {
    // allSettled, not all — one failing exporter must not strand the other.
    postHogFlush.mockRejectedValueOnce(new Error('posthog down'));
    flushAIObservability.mockClear();

    await expect(flushAnalytics()).resolves.toBeUndefined();

    expect(flushAIObservability).toHaveBeenCalledTimes(1);
  });

  it('resolves when getPostHogClient throws synchronously', async () => {
    // `getPostHogClient` constructs `new PostHog(...)` on first call. A throw
    // there happens while building the array literal, so it escapes
    // `allSettled` unless the call is wrapped in an async thunk.
    getPostHogClient.mockImplementationOnce(() => {
      throw new Error('PostHog constructor blew up');
    });

    await expect(flushAnalytics()).resolves.toBeUndefined();
  });

  it('resolves when PostHog is not configured', async () => {
    getPostHogClient.mockReturnValueOnce(null);

    await expect(flushAnalytics()).resolves.toBeUndefined();
  });
});
