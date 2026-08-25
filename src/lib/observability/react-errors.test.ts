import { OpenStoryError } from '@/lib/errors';
import { notFound, redirect } from '@tanstack/react-router';
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
      page_translated: false,
    });

    const other = new Error('hydration');
    captureReactError('recoverable', other, {});
    expect(captureException).toHaveBeenLastCalledWith(other, {
      react_error_kind: 'recoverable',
      component_stack: null,
      page_translated: false,
    });
    expect(captureException).toHaveBeenCalledTimes(2);

    flushReactErrors();
    expect(captureException).toHaveBeenCalledTimes(2);
  });

  it('captures a rethrown error once and skips router control flow and 404s', () => {
    captureException.mockClear();
    posthog.__loaded = true;

    const error = new Error('once');
    captureReactError('caught', error, {});
    captureReactError('caught', error, {});
    expect(captureException).toHaveBeenCalledTimes(1);

    captureReactError('caught', notFound(), {});
    captureReactError('caught', redirect({ to: '/' }), {});
    captureReactError(
      'caught',
      new OpenStoryError('gone', 'NOT_FOUND', 404),
      {}
    );
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});
