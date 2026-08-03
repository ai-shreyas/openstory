/**
 * Add Credits Dialog (#1099)
 * OpenAI-style "Add to credit balance" modal — the only way to add credits.
 * A saved card is charged in place; "+ Add payment method" (or having no
 * saved card) falls back to Stripe Checkout, which saves the card for next
 * time. Globally mounted in AppLayout, opened via openAddCreditsDialog().
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  createCheckoutSessionFn,
  listPaymentMethodsFn,
  purchaseCreditsFn,
} from '@/functions/billing';
import {
  prepareBalanceFlash,
  triggerBalanceFlash,
} from '@/hooks/use-balance-flash';
import {
  closeAddCreditsDialog,
  useAddCreditsDialogOpen,
} from '@/hooks/use-add-credits-dialog';
import { BILLING_BALANCE_KEY } from '@/hooks/use-billing-balance';
import { BILLING_GATE_KEY } from '@/hooks/use-billing-gate';
import { useSession } from '@/lib/auth/client';
import {
  formatPlatformFeePercent,
  MAX_TOPUP_AMOUNT_USD,
  MIN_TOPUP_AMOUNT_USD,
  splitCheckoutAmounts,
} from '@/lib/billing/constants';
import { usePostHog } from '@posthog/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CreditCard, ExternalLink, Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

/** Sentinel Select value for "pay with a new card at checkout". */
const NEW_CARD = 'new-card';

function formatBrand(brand: string): string {
  return brand.charAt(0).toUpperCase() + brand.slice(1);
}

export function AddCreditsDialog() {
  const open = useAddCreditsDialogOpen();
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const posthog = usePostHog();

  const [amount, setAmount] = useState('10');
  const [selectedPm, setSelectedPm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: pmData, isLoading: pmLoading } = useQuery({
    queryKey: ['billing-payment-methods'],
    queryFn: () => listPaymentMethodsFn(),
    staleTime: 60_000,
    enabled: open && !!session,
  });

  const paymentMethods = pmData?.paymentMethods ?? [];
  const effectivePm = selectedPm ?? paymentMethods[0]?.id ?? NEW_CARD;

  const amountUsd = parseFloat(amount);
  const isValidAmount =
    !isNaN(amountUsd) &&
    amountUsd >= MIN_TOPUP_AMOUNT_USD &&
    amountUsd <= MAX_TOPUP_AMOUNT_USD;
  const breakdown = isValidAmount ? splitCheckoutAmounts(amountUsd) : null;

  const onOpenChange = (next: boolean) => {
    if (!next) {
      setError(null);
      closeAddCreditsDialog();
    }
  };

  const invalidateBilling = () => {
    void queryClient.invalidateQueries({ queryKey: [...BILLING_BALANCE_KEY] });
    void queryClient.invalidateQueries({ queryKey: [...BILLING_GATE_KEY] });
    void queryClient.invalidateQueries({ queryKey: ['billing-invoices'] });
  };

  const purchaseMutation = useMutation({
    mutationFn: (input: { amountUsd: number; paymentMethodId: string }) =>
      purchaseCreditsFn({ data: input }),
    onSuccess: (_data, input) => {
      invalidateBilling();
      triggerBalanceFlash();
      toast.success(
        `Added $${input.amountUsd.toFixed(2)} to your credit balance`
      );
      onOpenChange(false);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Payment failed');
    },
  });

  const checkoutMutation = useMutation({
    mutationFn: (checkoutAmountUsd: number) =>
      createCheckoutSessionFn({ data: { amountUsd: checkoutAmountUsd } }),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Checkout failed');
    },
  });

  const isPending = purchaseMutation.isPending || checkoutMutation.isPending;

  const handleContinue = () => {
    if (!isValidAmount) {
      setError(
        `Enter an amount between $${MIN_TOPUP_AMOUNT_USD} and $${MAX_TOPUP_AMOUNT_USD.toLocaleString()}`
      );
      return;
    }
    setError(null);
    const method = effectivePm === NEW_CARD ? 'checkout' : 'saved_card';
    posthog.capture('credits_topup_started', {
      amount_usd: amountUsd,
      method,
    });
    if (method === 'checkout') {
      // Suggest this amount for auto-top-up on return from Stripe
      localStorage.setItem('openstory:last-topup-amount', String(amountUsd));
      prepareBalanceFlash();
      checkoutMutation.mutate(amountUsd);
      return;
    }
    purchaseMutation.mutate({ amountUsd, paymentMethodId: effectivePm });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Add to credit balance</DialogTitle>
          <DialogDescription className="sr-only">
            Buy credits with a saved card or at checkout.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <Label htmlFor="add-credits-amount">Amount to add</Label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
              $
            </span>
            <Input
              id="add-credits-amount"
              type="text"
              inputMode="decimal"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value.replace(/[^0-9.]/g, ''));
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleContinue();
              }}
              className="pl-7 tabular-nums"
              autoComplete="off"
            />
          </div>
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              Enter an amount between ${MIN_TOPUP_AMOUNT_USD} and $
              {MAX_TOPUP_AMOUNT_USD.toLocaleString()}
            </span>
            <Link
              to="/pricing"
              onClick={() => onOpenChange(false)}
              className="inline-flex shrink-0 items-center gap-1 underline-offset-2 hover:text-foreground hover:underline"
            >
              Pricing
              <ExternalLink className="size-3" />
            </Link>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="add-credits-payment-method">Payment method</Label>
          {pmLoading ? (
            <Skeleton className="h-9 w-full" />
          ) : (
            <Select
              value={effectivePm}
              onValueChange={(value) => {
                setSelectedPm(value);
                setError(null);
              }}
            >
              <SelectTrigger id="add-credits-payment-method" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {paymentMethods.map((pm) => (
                  <SelectItem key={pm.id} value={pm.id}>
                    <CreditCard className="size-4 text-muted-foreground" />
                    {formatBrand(pm.brand)} •••• {pm.last4}
                  </SelectItem>
                ))}
                <SelectItem value={NEW_CARD}>
                  <Plus className="size-4 text-muted-foreground" />
                  New card at checkout
                </SelectItem>
              </SelectContent>
            </Select>
          )}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => {
                setSelectedPm(NEW_CARD);
                setError(null);
              }}
              className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <Plus className="size-3" />
              Add payment method
            </button>
          </div>
        </div>

        {breakdown && (
          <p className="text-xs text-muted-foreground tabular-nums">
            You&apos;ll be charged ${breakdown.totalUsd.toFixed(2)} — includes
            the {formatPlatformFeePercent()} platform fee.
          </p>
        )}

        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleContinue}
            disabled={!isValidAmount || isPending}
          >
            {isPending ? 'Processing…' : 'Continue'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
