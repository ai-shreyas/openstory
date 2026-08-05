import { describe, expect, it, vi } from 'vitest';

const capture = vi.fn();
vi.doMock('@/lib/posthog-server', () => ({
  getPostHogClient: () => ({ capture }),
}));

const { captureProductEvent } = await import('./product-events');

describe('captureProductEvent', () => {
  it('forwards to posthog-node with distinctId + event', () => {
    capture.mockClear();
    captureProductEvent({
      distinctId: 'user_1',
      event: 'user_signed_up',
      properties: { email: 'a@b.com' },
    });
    expect(capture).toHaveBeenCalledWith({
      distinctId: 'user_1',
      event: 'user_signed_up',
      properties: { email: 'a@b.com' },
    });
  });
});
