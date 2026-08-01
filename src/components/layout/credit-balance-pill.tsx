/**
 * Quiet credit-balance control in the sidebar footer (below the social
 * separator, above the user menu) — account chrome, not product nav (#1090).
 *
 * Visible when:
 * 1. Low balance with no safety net (amber)
 * 2. Balance topped up — brief green flash
 * 3. User toggled "always show" on the credits page (muted)
 *
 * Expanded: wallet + $amount as muted text (no badge chrome).
 * Collapsed (icon rail): wallet icon only + tooltip with amount — never the
 * dollar string, so it cannot overlap the avatar.
 *
 * Subscribes to team billing SSE only while visible.
 */

import { cn } from '@/lib/utils';
import {
  SidebarMenu,
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

  useBillingBalanceRealtime(teamId, isVisible);

  if (!isVisible) return null;

  // Flash (green) > low (amber) > muted account chrome.
  const toneClass = isFlashing
    ? 'text-emerald-600 dark:text-emerald-400'
    : isLowBalanceVisible
      ? 'text-amber-600 dark:text-amber-400'
      : 'text-muted-foreground';

  const amount = `$${balance?.toFixed(2) ?? '0.00'}`;
  const tooltip = `Credits · ${amount}`;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          asChild
          tooltip={tooltip}
          className={cn(
            'animate-[balance-flash-in_300ms_ease-out_both]',
            toneClass,
            // Keep hover/active readable without fighting the tone tint.
            'hover:text-sidebar-accent-foreground data-active:text-sidebar-accent-foreground'
          )}
        >
          <Link
            to="/credits"
            search={{ tab: 'balance' }}
            aria-label={`Credit balance ${amount}. Open credits.`}
          >
            <Wallet />
            {/* Amount hides in icon mode via SidebarMenuButton truncation
                (span:last-child); tooltip carries the full amount. */}
            <span className="tabular-nums" aria-live="polite">
              {amount}
            </span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
};
