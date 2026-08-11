/**
 * Likely cost label under a generation action (#1140).
 *
 * Renders nothing when:
 * - the user turned action costs off (default is ON)
 * - there is no honest estimate (null) — never invent a number for display
 * - estimate is still loading and no value yet
 *
 * Prefixes with `~` — these are pre-flight estimates; billed units may differ.
 */

import { useShowActionCosts } from '@/hooks/use-show-action-costs';
import { microsToDisplayUsd, type Microdollars } from '@/lib/billing/money';
import { cn } from '@/lib/utils';

type ActionCostProps = {
  /** Honest estimate, or null when pricing is unknown for this action. */
  estimate: Microdollars | null | undefined;
  className?: string;
  /** Align under a full-width button vs. a right-aligned primary CTA. */
  align?: 'center' | 'end' | 'start';
};

export function ActionCost({
  estimate,
  className,
  align = 'center',
}: ActionCostProps) {
  const { showActionCosts } = useShowActionCosts();

  if (!showActionCosts || estimate == null) return null;

  const alignClass =
    align === 'end'
      ? 'text-right'
      : align === 'start'
        ? 'text-left'
        : 'text-center';

  return (
    <span
      className={cn(
        'block text-xs tabular-nums text-muted-foreground',
        alignClass,
        className
      )}
      aria-label={`Estimated cost about ${microsToDisplayUsd(estimate)}`}
    >
      ~{microsToDisplayUsd(estimate)}
    </span>
  );
}
