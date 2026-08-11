/**
 * Welcome Credits Dialog (#1096)
 *
 * Nudges teams that still have unused welcome credits. Shows while the team
 * has never spent credits (`credit_usage` ledger empty), at most once every
 * RESHOW_INTERVAL_MS after dismiss. No account-age check — established users
 * who never generate still get the prompt; anyone who has used credits never
 * sees it again.
 *
 * Dismiss cadence lives in localStorage (house pattern for UI prefs).
 */

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { openAddCreditsDialog } from '@/hooks/use-add-credits-dialog';
import { useBillingBalance } from '@/hooks/use-billing-balance';
import { useShowActionCosts } from '@/hooks/use-show-action-costs';
import { useShowBalance } from '@/hooks/use-show-balance';
import { useUser } from '@/hooks/use-user';
import { SIGNUP_GRANT_MICROS } from '@/lib/billing/constants';
import { microsToDisplayUsd } from '@/lib/billing/money';
import { Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';

/** Last dismiss timestamp (ms since epoch). */
const DISMISSED_AT_KEY = 'openstory:welcome-credits-dismissed-at';
/** Legacy one-shot flag — cleared so new re-show rules can apply. */
const LEGACY_SEEN_KEY = 'openstory:welcome-credits-seen';

/** Re-show after dismiss until the team has actually spent credits. */
const RESHOW_INTERVAL_MS = 3 * 60 * 60 * 1000;

const GRANT_DISPLAY = microsToDisplayUsd(SIGNUP_GRANT_MICROS);

function readDismissedAt(): number | null {
  try {
    // Drop the old permanent "seen" flag without treating it as a fresh
    // dismiss — otherwise anyone who hit the one-shot dialog is blocked
    // for 3h every time we migrate.
    if (localStorage.getItem(LEGACY_SEEN_KEY)) {
      localStorage.removeItem(LEGACY_SEEN_KEY);
    }

    const raw = localStorage.getItem(DISMISSED_AT_KEY);
    if (!raw) return null;
    const ts = Number(raw);
    return Number.isFinite(ts) ? ts : null;
  } catch {
    // private mode / quota
    return null;
  }
}

function writeDismissedAt(): void {
  try {
    localStorage.setItem(DISMISSED_AT_KEY, String(Date.now()));
    localStorage.removeItem(LEGACY_SEEN_KEY);
  } catch {
    // private mode / quota
  }
}

export const WelcomeCreditsDialog: React.FC = () => {
  const { data: user } = useUser();
  const { showBalance, setShowBalance } = useShowBalance();
  const { showActionCosts, setShowActionCosts } = useShowActionCosts();
  const {
    stripeEnabled,
    hasUsedCredits,
    isSuccess: balanceReady,
    isError: balanceFailed,
  } = useBillingBalance();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!user) return;
    // Wait until balance query settles (success or error). Don't use isFetched
    // alone — while the query is disabled it stays false forever.
    if (!balanceReady && !balanceFailed) return;
    // On balance error, still show the dialog (hasUsedCredits defaults false).
    if (hasUsedCredits) return;

    const dismissedAt = readDismissedAt();
    if (dismissedAt != null && Date.now() - dismissedAt < RESHOW_INTERVAL_MS) {
      return;
    }
    setOpen(true);
  }, [user, hasUsedCredits, balanceReady, balanceFailed]);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      writeDismissedAt();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
        {/* Gift header — soft primary wash, amount is the hero */}
        <div className="relative overflow-hidden border-b bg-gradient-to-br from-primary/20 via-primary/10 to-transparent px-6 pb-6 pt-8">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-8 -top-10 size-40 rounded-full bg-primary/15 blur-2xl"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -bottom-12 -left-6 size-32 rounded-full bg-emerald-500/10 blur-2xl"
          />

          <div className="relative flex flex-col items-center gap-3 text-center">
            <div className="flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm ring-4 ring-primary/15">
              <Sparkles className="size-6" aria-hidden />
            </div>
            <p className="text-xs font-medium uppercase tracking-widest text-primary">
              Welcome gift
            </p>
            <DialogHeader className="items-center gap-1.5 sm:text-center">
              <DialogTitle className="font-heading text-3xl font-bold tracking-tight tabular-nums sm:text-4xl">
                {GRANT_DISPLAY}
              </DialogTitle>
              <DialogDescription className="max-w-xs text-sm leading-relaxed">
                Free credits on us — enough for a typical 30s short with motion
                and music. Generations draw from this balance at provider rates.
              </DialogDescription>
            </DialogHeader>
          </div>
        </div>

        <div className="flex flex-col gap-4 px-6 py-5">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3 rounded-xl border border-primary/15 bg-primary/[0.04] p-3.5">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">Show credits in sidebar</p>
                <p className="text-xs text-muted-foreground">
                  Keep your balance visible above your account
                </p>
              </div>
              <Switch
                checked={showBalance}
                onCheckedChange={setShowBalance}
                aria-label="Show credits in sidebar"
              />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-xl border border-primary/15 bg-primary/[0.04] p-3.5">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">Show cost on actions</p>
                <p className="text-xs text-muted-foreground">
                  Estimate generation cost under Generate and other actions
                </p>
              </div>
              <Switch
                checked={showActionCosts}
                onCheckedChange={setShowActionCosts}
                aria-label="Show cost on actions"
              />
            </div>
          </div>

          <DialogFooter className="gap-2 sm:justify-stretch">
            {stripeEnabled ? (
              <Button
                variant="outline"
                className="sm:flex-1"
                onClick={() => {
                  handleOpenChange(false);
                  openAddCreditsDialog();
                }}
              >
                Buy more
              </Button>
            ) : null}
            <Button
              className="sm:flex-1"
              onClick={() => handleOpenChange(false)}
            >
              Start creating
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
};
