/**
 * Quiet credit-balance chip in the sidebar footer (above the user menu).
 *
 * Visible when:
 * 1. Low balance with no safety net (amber)
 * 2. Balance topped up — brief green flash
 * 3. User toggled "always show" on the credits page (muted)
 *
 * While visible, subscribes to team billing SSE so generation / enhance
 * deductions update the amount live (#1090). Intentionally not a nav row —
 * dollars are status chrome, not a peer of Sequences/Gallery.
 */

import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { useBalanceFlash } from '@/hooks/use-balance-flash';
import { useBillingBalance } from '@/hooks/use-billing-balance';
import { useBillingBalanceRealtime } from '@/hooks/use-billing-balance-realtime';
import { useBillingGateQuery } from '@/hooks/use-billing-gate';
import { useShowBalance } from '@/hooks/use-show-balance';
import { Link } from '@tanstack/react-router';

export const CreditBalancePill: React.FC = () => {
  const { balance, teamId, isLowBalance } = useBillingBalance();
  const { data: gateStatus } = useBillingGateQuery();
  const { showBalance } = useShowBalance();
  const { isFlashing } = useBalanceFlash();

  // A fal key alone covers generation (LLM calls route through fal's
  // OpenRouter endpoint); an OpenRouter key alone doesn't cover media.
  const hasSafetyNet = gateStatus?.hasAutoTopUp || gateStatus?.hasFalKey;

  const isLowBalanceVisible = isLowBalance && !hasSafetyNet;
  const isVisible = isLowBalanceVisible || showBalance || isFlashing;

  // Subscribe only while the chip would render — no SSE when hidden.
  useBillingBalanceRealtime(teamId, isVisible);

  if (!isVisible) return null;

  // Flash (green) takes priority, then low-balance (amber), then muted.
  const badgeTone = isFlashing
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
    : isLowBalanceVisible
      ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400'
      : 'border-border/50 bg-transparent text-muted-foreground';

  const amount = `$${balance?.toFixed(2) ?? '0.00'}`;

  return (
    <div className="px-2 py-1 group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center">
      <Link
        to="/credits"
        search={{ tab: 'balance' }}
        title={`Credits ${amount}`}
        aria-label={`Credit balance ${amount}. Open credits.`}
        className={cn(
          'flex w-full items-center justify-start rounded-md outline-none',
          'focus-visible:ring-2 focus-visible:ring-ring',
          'group-data-[collapsible=icon]:w-auto group-data-[collapsible=icon]:justify-center'
        )}
      >
        <Badge
          variant="outline"
          className={cn(
            'max-w-full truncate font-normal tabular-nums',
            'animate-[balance-flash-in_300ms_ease-out_both]',
            badgeTone
          )}
        >
          {amount}
        </Badge>
      </Link>
    </div>
  );
};
