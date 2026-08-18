import { describe, expect, it, vi } from 'vitest';

const capture = vi.fn();
const identify = vi.fn();
const alias = vi.fn();
vi.doMock('@/lib/posthog-server', () => ({
  getPostHogClient: () => ({ capture, identify, alias }),
}));

const { aliasDistinctId, captureProductEvent } =
  await import('./product-events');

describe('captureProductEvent', () => {
  it('forwards to posthog-node with distinctId + event', () => {
    capture.mockClear();
    identify.mockClear();
    captureProductEvent({
      distinctId: 'user_1',
      event: 'user_signed_up',
      properties: { email: 'a@b.com' },
    });
    expect(identify).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledWith({
      distinctId: 'user_1',
      event: 'user_signed_up',
      properties: { email: 'a@b.com' },
    });
  });

  it('identifies the person and $sets person properties on the event (#1110)', () => {
    capture.mockClear();
    identify.mockClear();
    captureProductEvent({
      distinctId: 'user_1',
      event: 'user_signed_up',
      properties: {
        email: 'a@b.com',
        name: 'Ada',
        team_id: 'team_1',
      },
      personProperties: {
        email: 'a@b.com',
        name: 'Ada',
      },
    });
    expect(identify).toHaveBeenCalledWith({
      distinctId: 'user_1',
      properties: { email: 'a@b.com', name: 'Ada' },
    });
    expect(capture).toHaveBeenCalledWith({
      distinctId: 'user_1',
      event: 'user_signed_up',
      properties: {
        email: 'a@b.com',
        name: 'Ada',
        team_id: 'team_1',
        $set: { email: 'a@b.com', name: 'Ada' },
      },
    });
  });

  it('skips identify and $set when personProperties is empty', () => {
    capture.mockClear();
    identify.mockClear();
    captureProductEvent({
      distinctId: 'user_1',
      event: 'user_signed_in',
      properties: { path: '/api/auth/sign-in' },
      personProperties: {},
    });
    expect(identify).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledWith({
      distinctId: 'user_1',
      event: 'user_signed_in',
      properties: { path: '/api/auth/sign-in' },
    });
  });
});

describe('aliasDistinctId', () => {
  it('links the anonymous device id to the signed-up user', () => {
    alias.mockClear();
    aliasDistinctId({ distinctId: 'user_1', alias: 'anon_1' });
    expect(alias).toHaveBeenCalledWith({
      distinctId: 'user_1',
      alias: 'anon_1',
    });
  });
});
