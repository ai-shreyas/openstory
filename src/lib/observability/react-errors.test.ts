import { describe, expect, it, vi } from 'vitest';

const captureException = vi.fn();
const posthog = { __loaded: false, captureException };
vi.doMock('posthog-js', () => ({ default: posthog }));

const { captureReactError, flushReactErrors } = await import('./react-errors');

describe('captureReactError', () => {
  it('queues before PostHog loads, flushes once it has, then captures directly', () => {
    const error = new Error('insertBefore');
    captureReactError('caught', error, { componentStack: '\n at Composer' });
    expect(captureException).not.toHaveBeenCalled();

    posthog.__loaded = true;
    flushReactErrors();
    expect(captureException).toHaveBeenCalledWith(error, {
      react_error_kind: 'caught',
      component_stack: '\n at Composer',
    });

    captureReactError('recoverable', error, {});
    expect(captureException).toHaveBeenLastCalledWith(error, {
      react_error_kind: 'recoverable',
      component_stack: null,
    });
    expect(captureException).toHaveBeenCalledTimes(2);

    flushReactErrors();
    expect(captureException).toHaveBeenCalledTimes(2);
  });
});
