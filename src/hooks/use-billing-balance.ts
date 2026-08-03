/**
 * Shared billing balance hook
 * Provides balance data, low-balance detection, and query key for invalidation
 */

import { useQuery } from '@tanstack/react-query';
import { sessionQueryOptions } from '@/lib/auth/session-query';
import { LOW_BALANCE_THRESHOLD_USD } from '@/lib/billing/constants';
import { getBillingBalanceFn } from '@/functions/billing';

export const BILLING_BALANCE_KEY = ['billing-balance'] as const;

export function useBillingBalance() {
  // Same session cache as useUser / _app beforeLoad — not better-auth's
  // useSession(), which can lag or stay empty while the RQ session is ready
  // (that left WelcomeCreditsDialog stuck on !isFetched forever).
  const { data: session } = useQuery(sessionQueryOptions);

  const query = useQuery({
    queryKey: [...BILLING_BALANCE_KEY],
    queryFn: () => getBillingBalanceFn(),
    staleTime: 30_000,
    enabled: !!session?.user,
  });

  const balance = query.data?.balance ?? null;
  const autoTopUp = query.data?.autoTopUp;
  const lowBalanceThreshold =
    autoTopUp?.enabled && autoTopUp.thresholdUsd != null
      ? autoTopUp.thresholdUsd
      : LOW_BALANCE_THRESHOLD_USD;

  return {
    ...query,
    balance,
    teamId: query.data?.teamId,
    stripeEnabled: query.data?.stripeEnabled ?? false,
    hasUsedCredits: query.data?.hasUsedCredits ?? false,
    isLowBalance:
      balance !== null && balance > 0 && balance <= lowBalanceThreshold,
    isZeroBalance: balance !== null && balance <= 0,
    lowBalanceThreshold,
  };
}
