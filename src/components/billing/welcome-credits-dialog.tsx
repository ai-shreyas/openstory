/**
 * Welcome Credits Dialog (#1096)
 *
 * One-time announcement of the signup credit grant. Shows on the first app
 * load after signup, offers the "show credits in sidebar" switch (default
 * off — same store as the credits-page toggle), and links to buy more.
 *
 * Seen-state lives in localStorage (house pattern for UI prefs), guarded by
 * account age so an established user on a fresh browser never sees it — the
 * flag is written either way so the check runs once per browser.
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
import { useBillingBalance } from '@/hooks/use-billing-balance';
import { useShowBalance } from '@/hooks/use-show-balance';
import { useUser } from '@/hooks/use-user';
import { SIGNUP_GRANT_MICROS } from '@/lib/billing/constants';
import { microsToDisplayUsd } from '@/lib/billing/money';
import { Link } from '@tanstack/react-router';
import { Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';

const SEEN_KEY = 'openstory:welcome-credits-seen';

/** Accounts older than this never get the dialog (signup grant is long spent
 * or long known — this is a signup announcement, not a recurring banner). */
const MAX_ACCOUNT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const GRANT_DISPLAY = microsToDisplayUsd(SIGNUP_GRANT_MICROS);

export const WelcomeCreditsDialog: React.FC = () => {
  const { data: user } = useUser();
  const { showBalance, setShowBalance } = useShowBalance();
  const { stripeEnabled } = useBillingBalance();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!user) return;
    try {
      if (localStorage.getItem(SEEN_KEY)) return;
      const createdAt = new Date(user.createdAt).getTime();
      const isNewAccount =
        !Number.isNaN(createdAt) && Date.now() - createdAt < MAX_ACCOUNT_AGE_MS;
      if (!isNewAccount) {
        localStorage.setItem(SEEN_KEY, 'true');
        return;
      }
      setOpen(true);
    } catch {
      // private mode / quota — skip rather than re-announce on every load
    }
  }, [user]);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      try {
        localStorage.setItem(SEEN_KEY, 'true');
      } catch {
        // private mode / quota — dialog just closes for this session
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Sparkles className="size-5" />
          </div>
          <DialogTitle>
            You&rsquo;ve got {GRANT_DISPLAY} of welcome credits
          </DialogTitle>
          <DialogDescription>
            Every new account starts with {GRANT_DISPLAY} of credits — enough to
            create your first sequence, on us. Generations draw from this
            balance at provider cost.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between rounded-xl border border-border/60 p-3.5">
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

        <DialogFooter className="gap-2 sm:justify-between">
          {stripeEnabled ? (
            <Button variant="outline" asChild>
              <Link to="/credits" onClick={() => handleOpenChange(false)}>
                Buy more credits
              </Link>
            </Button>
          ) : (
            <span />
          )}
          <Button onClick={() => handleOpenChange(false)}>
            Start creating
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
