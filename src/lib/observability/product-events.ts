/**
 * Product analytics events that drive PostHog → Slack alerts (#1088).
 *
 * Prefer server-side capture so OAuth redirects, passkeys, and the public API
 * all emit the same events. Failures must never break the critical path.
 */

import { getPostHogClient } from '@/lib/posthog-server';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'observability', 'product-events']);

type ProductEventName =
  | 'user_signed_up'
  | 'user_signed_in'
  | 'sequence_generated'
  | 'founder_credits_requested';

export type CaptureProductEventArgs = {
  distinctId: string;
  event: ProductEventName;
  properties?: Record<string, unknown>;
};

/**
 * Fire-and-forget PostHog product event. Never throws.
 */
export function captureProductEvent(args: CaptureProductEventArgs): void {
  try {
    const posthog = getPostHogClient();
    if (!posthog) return;
    posthog.capture({
      distinctId: args.distinctId,
      event: args.event,
      properties: args.properties,
    });
  } catch (err) {
    logger.error('captureProductEvent failed', {
      event: args.event,
      distinctId: args.distinctId,
      err,
    });
  }
}
