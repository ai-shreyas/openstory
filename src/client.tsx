import { captureReactError } from '@/lib/observability/react-errors';
import { StartClient } from '@tanstack/react-start/client';
import { StrictMode, startTransition } from 'react';
import { hydrateRoot } from 'react-dom/client';

// TanStack Start's default client entry, plus React 19's root error hooks so
// boundary-caught crashes and hydration mismatches reach PostHog with a
// component stack (#1283). Uncaught errors keep React's default `reportError`
// path, which PostHog's autocapture already sees.
startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <StartClient />
    </StrictMode>,
    {
      onCaughtError: (error, info) => captureReactError('caught', error, info),
      onRecoverableError: (error, info) =>
        captureReactError('recoverable', error, info),
    }
  );
});
