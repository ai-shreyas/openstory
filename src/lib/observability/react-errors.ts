/**
 * React root error hooks → PostHog (#1283).
 *
 * An error a boundary catches never reaches `window.onerror`, so PostHog's
 * exception autocapture missed every "Something went wrong" screen (the
 * insertBefore/removeChild crashes). `hydrateRoot`'s `onCaughtError` and
 * `onRecoverableError` see all of them, with the component stack.
 *
 * PostHog inits in a provider effect — after hydration-time recoverable
 * errors (#418) have already fired — so pre-init captures queue until the
 * SDK's `loaded` callback calls `flushReactErrors`.
 */

import { errorCode } from '@/lib/errors';
import { getLogger } from '@/lib/observability/logger';
import { isNotFound, isRedirect } from '@tanstack/react-router';
import posthog from 'posthog-js';
import type { ErrorInfo } from 'react';

const logger = getLogger(['openstory', 'ui', 'react-errors']);

type ReactErrorKind = 'caught' | 'recoverable';
type Pending = [error: unknown, props: Record<string, unknown>];

// Bounded: without a PostHog token the SDK never loads, so this never drains.
const MAX_PENDING = 20;
const pending: Pending[] = [];

// TanStack re-throws a caught error from `componentDidCatch` when it belongs
// to a parent route, so one error re-enters here once per nested boundary.
const seen = new WeakSet<object>();

export function captureReactError(
  kind: ReactErrorKind,
  error: unknown,
  info: ErrorInfo
): void {
  // Router control flow (`notFound()`, `redirect()`) and a 404 from a stale
  // link are routed through the same boundaries but are not app errors.
  if (
    isNotFound(error) ||
    isRedirect(error) ||
    errorCode(error) === 'NOT_FOUND'
  ) {
    return;
  }
  if (typeof error === 'object' && error !== null) {
    if (seen.has(error)) return;
    seen.add(error);
  }
  const props = {
    react_error_kind: kind,
    component_stack: info.componentStack ?? null,
    // Chrome translate leaves these wrappers; lets the dashboard split
    // translate-induced hydration mismatches (#418) from real ones.
    page_translated:
      typeof document !== 'undefined' &&
      document.querySelector('font[style*="vertical-align: inherit"]') !== null,
  };
  logger.error(`react ${kind} error`, { err: error, ...props });
  if (posthog.__loaded) {
    posthog.captureException(error, props);
  } else if (pending.length < MAX_PENDING) {
    pending.push([error, props]);
  }
}

export function flushReactErrors(): void {
  for (const [error, props] of pending.splice(0)) {
    posthog.captureException(error, props);
  }
}
