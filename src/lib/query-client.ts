import { openBillingGate } from '@/hooks/use-billing-gate-dialog';
import { isInsufficientCreditsError } from '@/lib/errors';
import { MutationCache, QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'query-client', 'query-client']);

export function makeQueryClient() {
  let qc!: QueryClient;
  qc = new QueryClient({
    mutationCache: new MutationCache({
      onSuccess: (_data, _variables, _context, mutation) => {
        void qc.invalidateQueries({
          queryKey: mutation.options.mutationKey,
        });
      },
      onError: (error) => {
        logger.error('[MUTATION ERROR]', {
          data: error instanceof Error ? error.message : error,
        });
        // Out of credits is a billing problem, not an error toast — open the
        // globally-mounted gate dialog instead (#1099).
        if (isInsufficientCreditsError(error)) {
          openBillingGate();
          return;
        }
        toast.error(error.message);
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 2 * 60 * 1000,
      },
    },
  });
  return qc;
}

let browserQueryClient: QueryClient | undefined;

/**
 * Returns a QueryClient singleton on the client, fresh instance on the server.
 * Shared between TanStack Router context and Better Auth hooks.
 */
export function getQueryClient() {
  if (typeof window === 'undefined') {
    return makeQueryClient();
  }
  if (!browserQueryClient) {
    browserQueryClient = makeQueryClient();
  }
  return browserQueryClient;
}
