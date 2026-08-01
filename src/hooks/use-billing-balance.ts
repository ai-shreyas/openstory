/**
 * Shared billing balance hook
 * Provides balance data, low-balance detection, and query key for invalidation
 */

import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/lib/auth/client';
import { LOW_BALANCE_THRESHOLD_USD } from '@/lib/billing/constants';
import { getBillingBalanceFn } from '@/functions/billing';

export const BILLING_BALANCE_KEY = ['billing-balance'] as const;

export function useBillingBalance() {
  const { data: session } = useSession();

  const query = useQuery({
    queryKey: [...BILLING_BALANCE_KEY],
    queryFn: () => getBillingBalanceFn(),
    staleTime: 30_000,
    enabled: !!session,
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
    isLowBalance:
      balance !== null && balance > 0 && balance <= lowBalanceThreshold,
    isZeroBalance: balance !== null && balance <= 0,
    lowBalanceThreshold,
  };
}
