/**
 * Credit Balance Sidebar Row
 * Shows credit balance as a sidebar nav row. Visible when:
 * 1. Low balance with no safety net (amber warning)
 * 2. Balance topped up — stays until credits are drawn down (green)
 * 3. User toggled "always show" in credits page (neutral)
 *
 * While visible, subscribes to team billing SSE so generation deductions
 * update the amount live (#1090).
 */

import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import {
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { useBalanceFlash } from '@/hooks/use-balance-flash';
import { useBillingBalance } from '@/hooks/use-billing-balance';
import { useBillingBalanceRealtime } from '@/hooks/use-billing-balance-realtime';
import { useBillingGateQuery } from '@/hooks/use-billing-gate';
import { useShowBalance } from '@/hooks/use-show-balance';
import { Link } from '@tanstack/react-router';
import { Wallet } from 'lucide-react';

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

  // Subscribe only while the pill would render — no SSE when hidden.
  useBillingBalanceRealtime(teamId, isVisible);

  if (!isVisible) return null;

  // Flash (green) takes priority, then low-balance (amber), then neutral.
  const badgeTone = isFlashing
    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-transparent'
    : isLowBalanceVisible
      ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-transparent'
      : undefined;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild tooltip="Credits">
        <Link to="/credits">
          <Wallet />
          <span>Credits</span>
        </Link>
      </SidebarMenuButton>
      {/* SidebarMenuBadge is only the absolute positioner; Badge is the pill. */}
      <SidebarMenuBadge className="h-auto min-w-0 p-0 peer-hover/menu-button:text-inherit peer-data-active/menu-button:text-inherit">
        <Badge
          variant="secondary"
          className={cn(
            'tabular-nums animate-[balance-flash-in_300ms_ease-out_both]',
            badgeTone
          )}
        >
          ${balance?.toFixed(2) ?? '0.00'}
        </Badge>
      </SidebarMenuBadge>
    </SidebarMenuItem>
  );
};
