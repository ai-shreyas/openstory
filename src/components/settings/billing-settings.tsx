/**
 * Billing Settings Component
 * Credit balance, top-up buttons, auto-top-up config, and invoices
 */

import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  createCheckoutSessionFn,
  getTransactionsFn,
  updateAutoTopUpFn,
} from '@/functions/billing';
import {
  clearBalanceFlash,
  prepareBalanceFlash,
} from '@/hooks/use-balance-flash';
import {
  BILLING_BALANCE_KEY,
  useBillingBalance,
} from '@/hooks/use-billing-balance';
import { BILLING_GATE_KEY } from '@/hooks/use-billing-gate';
import { useShowBalance } from '@/hooks/use-show-balance';
import {
  formatProcessingFeePercent,
  MIN_TOPUP_AMOUNT_USD,
  PRESET_TOPUP_AMOUNTS_USD,
  splitCheckoutAmounts,
} from '@/lib/billing/constants';
import { usePostHog } from '@posthog/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  CreditCard,
  DollarSign,
  ExternalLink,
  RefreshCw,
  Wallet,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

type BillingSettingsProps = {
  success?: boolean;
  canceled?: boolean;
};

type SectionHeaderProps = {
  icon: LucideIcon;
  title: string;
  description: string;
};

function SectionHeader({
  icon: Icon,
  title,
  description,
  action,
}: SectionHeaderProps & { action?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10">
        <Icon className="h-5 w-5 text-primary" />
      </div>
      <div className="flex-1">
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </div>
      {action}
    </div>
  );
}

function getErrorMessage(
  error: string | null,
  balanceError: Error | null
): string {
  if (error) return error;
  if (balanceError instanceof Error) return balanceError.message;
  return 'Something went wrong';
}

const RETURN_KEY = 'openstory:billing-return';

export function BillingSettings({ success, canceled }: BillingSettingsProps) {
  const queryClient = useQueryClient();
  const posthog = usePostHog();
  const [error, setError] = useState<string | null>(null);
  const [customAmount, setCustomAmount] = useState('');
  const [selectedAmount, setSelectedAmount] = useState<number | null>(100);
  const [autoTopUpPrompt, setAutoTopUpPrompt] = useState<number | null>(null);
  const navigate = useNavigate();

  // Handle checkout return — runs once when returning from Stripe with success or canceled params
  const checkoutHandledRef = useRef(false);
  useEffect(() => {
    if (checkoutHandledRef.current || (!success && !canceled)) return;
    checkoutHandledRef.current = true;

    // Clear pending flash marker on cancel
    if (canceled) clearBalanceFlash();

    // Refetch balance + show return toast on success
    if (success) {
      void queryClient.invalidateQueries({
        queryKey: [...BILLING_BALANCE_KEY],
      });
      void queryClient.invalidateQueries({
        queryKey: ['billing-invoices'],
      });
      void queryClient.invalidateQueries({
        queryKey: [...BILLING_GATE_KEY],
      });

      const returnTo = localStorage.getItem(RETURN_KEY);
      if (returnTo) {
        localStorage.removeItem(RETURN_KEY);
        toast.success('Credits added successfully', {
          description: 'Your balance has been updated.',
          action: {
            label: 'Continue creating',
            onClick: () => void navigate({ to: returnTo }),
          },
          duration: 15_000,
        });
      }
    }

    // Clear success/canceled from URL after showing
    const timer = setTimeout(() => {
      window.history.replaceState({}, '', '/credits');
    }, 5000);
    return () => clearTimeout(timer);
  }, [success, canceled, queryClient, navigate]);

  const {
    data: balanceData,
    isLoading: balanceLoading,
    error: balanceError,
  } = useBillingBalance();

  // After successful top-up, prompt to enable auto-topup if not already on
  useEffect(() => {
    if (!success || balanceLoading || !balanceData) return;
    if (balanceData.autoTopUp.enabled) return;

    const lastAmount = localStorage.getItem('openstory:last-topup-amount');
    localStorage.removeItem('openstory:last-topup-amount');
    const amount = lastAmount ? parseFloat(lastAmount) : null;
    if (amount && !isNaN(amount) && amount >= MIN_TOPUP_AMOUNT_USD) {
      setAutoTopUpPrompt(amount);
    }
  }, [success, balanceLoading, balanceData]);

  const stripeEnabled = balanceData?.stripeEnabled ?? false;

  const {
    data: invoiceData,
    isLoading: invoicesLoading,
    error: invoicesError,
  } = useQuery({
    queryKey: ['billing-invoices'],
    queryFn: () =>
      getTransactionsFn({
        data: { type: 'credit_purchase', limit: 10, offset: 0 },
      }),
    staleTime: 5 * 60 * 1000,
  });

  const checkoutMutation = useMutation({
    mutationFn: (amountUsd: number) =>
      createCheckoutSessionFn({ data: { amountUsd } }),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Checkout failed');
    },
  });

  const autoTopUpMutation = useMutation({
    mutationFn: (body: {
      enabled: boolean;
      thresholdUsd?: number;
      amountUsd?: number;
    }) => updateAutoTopUpFn({ data: body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [...BILLING_BALANCE_KEY],
      });
      setError(null);
    },
    onError: (err) => {
      setError(
        err instanceof Error ? err.message : 'Failed to update auto top-up'
      );
    },
  });

  const effectiveAmount = selectedAmount ?? parseFloat(customAmount);
  const isValidAmount =
    !isNaN(effectiveAmount) && effectiveAmount >= MIN_TOPUP_AMOUNT_USD;
  const checkoutBreakdown = isValidAmount
    ? splitCheckoutAmounts(effectiveAmount)
    : null;
  const feePercent = formatProcessingFeePercent();
  const autoTopUpThreshold =
    autoTopUpPrompt !== null ? Math.ceil((autoTopUpPrompt * 0.1) / 5) * 5 : 5;

  const handleTopUp = () => {
    if (!isValidAmount) {
      setError(`Minimum top-up is $${MIN_TOPUP_AMOUNT_USD}`);
      return;
    }
    posthog.capture('credits_topup_started', { amount_usd: effectiveAmount });
    // Remember the amount so we can suggest it for auto-topup after checkout
    localStorage.setItem(
      'openstory:last-topup-amount',
      String(effectiveAmount)
    );
    // Set pending marker before Stripe redirect so the flash shows on return
    prepareBalanceFlash();
    checkoutMutation.mutate(effectiveAmount);
  };

  return (
    <div className="space-y-6">
      {success && (
        <Alert className="mb-4">
          <AlertDescription>
            Credits added successfully. Your balance has been updated.
          </AlertDescription>
        </Alert>
      )}

      {canceled && (
        <Alert className="mb-4">
          <AlertDescription>
            Top-up canceled. No charges were made.
          </AlertDescription>
        </Alert>
      )}

      <AlertDialog open={autoTopUpPrompt !== null}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enable Auto Top-Up?</AlertDialogTitle>
            <AlertDialogDescription>
              Automatically add ${autoTopUpPrompt} when your balance drops below
              ${autoTopUpThreshold}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setAutoTopUpPrompt(null)}>
              No thanks
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                autoTopUpMutation.mutate({
                  enabled: true,
                  thresholdUsd: autoTopUpThreshold,
                  amountUsd: autoTopUpPrompt ?? 0,
                });
                setAutoTopUpPrompt(null);
              }}
              disabled={autoTopUpMutation.isPending}
            >
              {autoTopUpMutation.isPending ? 'Enabling…' : 'Enable auto top-up'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {(error || balanceError || invoicesError) && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>
            {getErrorMessage(error, balanceError)}
          </AlertDescription>
        </Alert>
      )}

      {/* Balance Card */}
      <Card>
        <CardHeader>
          <SectionHeader
            icon={Wallet}
            title="Credit Balance"
            description="Pay-as-you-go wallet for AI generation at provider cost"
          />
        </CardHeader>
        <CardContent className="space-y-4">
          {balanceLoading ? (
            <Skeleton className="h-12 w-32" />
          ) : (
            <p className="text-4xl font-bold tabular-nums">
              ${balanceData?.balance.toFixed(2) ?? '0.00'}
            </p>
          )}
          <ShowBalanceToggle />
        </CardContent>
      </Card>

      {!stripeEnabled && !balanceLoading && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              Credits can be added via gift codes.
            </p>
            <div className="pt-2">
              <Link
                to="/credits"
                search={{ tab: 'transactions' }}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                View all transactions
              </Link>
            </div>
          </CardContent>
        </Card>
      )}

      {stripeEnabled && (
        <>
          {/* Top Up Card */}
          <Card>
            <CardHeader>
              <SectionHeader
                icon={DollarSign}
                title="Add Credits"
                description={`Credits are billed at provider cost. A ${feePercent} processing fee applies at purchase — not on usage.`}
              />
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                {PRESET_TOPUP_AMOUNTS_USD.map((amount) => (
                  <Button
                    key={amount}
                    variant={selectedAmount === amount ? 'default' : 'outline'}
                    className="h-12 text-lg font-semibold tabular-nums"
                    onClick={() => {
                      setSelectedAmount(amount);
                      setCustomAmount('');
                      setError(null);
                    }}
                    disabled={checkoutMutation.isPending}
                  >
                    ${amount}
                  </Button>
                ))}
              </div>

              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                  $
                </span>
                <Input
                  type="text"
                  inputMode="decimal"
                  placeholder={`Custom (${MIN_TOPUP_AMOUNT_USD}+)`}
                  value={customAmount}
                  onChange={(e) => {
                    setCustomAmount(e.target.value.replace(/[^0-9.]/g, ''));
                    setSelectedAmount(null);
                    setError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleTopUp();
                  }}
                  className="pl-7 tabular-nums"
                  autoComplete="off"
                />
              </div>

              {checkoutBreakdown && (
                <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm">
                  <div className="flex justify-between tabular-nums">
                    <span className="text-muted-foreground">Credits</span>
                    <span>${checkoutBreakdown.creditUsd.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between tabular-nums">
                    <span className="text-muted-foreground">
                      Processing fee ({feePercent})
                    </span>
                    <span>${checkoutBreakdown.feeUsd.toFixed(2)}</span>
                  </div>
                  <div className="mt-2 flex justify-between border-t pt-2 font-medium tabular-nums">
                    <span>Total charged</span>
                    <span>${checkoutBreakdown.totalUsd.toFixed(2)}</span>
                  </div>
                </div>
              )}

              <Button
                onClick={handleTopUp}
                disabled={!isValidAmount || checkoutMutation.isPending}
                className="w-full"
              >
                {checkoutMutation.isPending
                  ? 'Loading…'
                  : checkoutBreakdown
                    ? `Pay $${checkoutBreakdown.totalUsd.toFixed(2)}`
                    : 'Top up'}
              </Button>

              <p className="text-center text-xs text-muted-foreground">
                <Link to="/pricing" className="underline hover:text-foreground">
                  View full model pricing
                </Link>
              </p>

              {!balanceLoading && !balanceData?.hasPaymentMethod && (
                <p className="text-xs text-muted-foreground">
                  Your payment method will be saved. After your first purchase,
                  you'll be able to enable auto top-up.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Auto Top-Up Card */}
          <AutoTopUpCard
            balanceLoading={balanceLoading}
            balanceData={balanceData}
            isPending={autoTopUpMutation.isPending}
            onSave={(settings) => {
              if (settings.enabled) {
                posthog.capture('auto_topup_enabled', {
                  threshold_usd: settings.thresholdUsd,
                  amount_usd: settings.amountUsd,
                });
              }
              autoTopUpMutation.mutate(settings);
            }}
          />

          {/* Invoices */}
          <Card>
            <CardHeader>
              <SectionHeader
                icon={CreditCard}
                title="Invoices"
                description="Recent purchases"
              />
            </CardHeader>
            <CardContent>
              {invoicesLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                </div>
              ) : invoiceData?.transactions.length === 0 ? (
                <p className="text-center text-muted-foreground py-4">
                  No purchases yet
                </p>
              ) : (
                <div className="space-y-2">
                  {invoiceData?.transactions.map((tx) => (
                    <div
                      key={tx.id}
                      className="flex items-center justify-between rounded-lg border p-3"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {tx.description ?? 'Credit purchase'}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(tx.createdAt).toLocaleString()}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 ml-4">
                        <span className="text-sm font-semibold tabular-nums text-green-600 dark:text-green-400">
                          +${tx.amount.toFixed(2)}
                        </span>
                        {tx.metadata?.receiptUrl && (
                          <a
                            href={tx.metadata.receiptUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-muted-foreground hover:text-foreground"
                            aria-label="View receipt"
                          >
                            <ExternalLink className="h-4 w-4" />
                          </a>
                        )}
                      </div>
                    </div>
                  ))}

                  <div className="pt-2 text-center">
                    <Link
                      to="/credits"
                      search={{ tab: 'transactions' }}
                      className="text-sm text-muted-foreground hover:text-foreground"
                    >
                      View all transactions
                    </Link>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function ShowBalanceToggle() {
  const { showBalance, setShowBalance } = useShowBalance();

  return (
    <div className="flex items-center justify-between border-t pt-4">
      <div>
        <p className="text-sm font-medium">Show balance in sidebar</p>
        <p className="text-xs text-muted-foreground">
          Always display your credit balance above your account
        </p>
      </div>
      <Switch checked={showBalance} onCheckedChange={setShowBalance} />
    </div>
  );
}

type AutoTopUpCardProps = {
  balanceLoading: boolean;
  balanceData: ReturnType<typeof useBillingBalance>['data'];
  isPending: boolean;
  onSave: (settings: {
    enabled: boolean;
    thresholdUsd?: number;
    amountUsd?: number;
  }) => void;
};

function AutoTopUpCard({
  balanceLoading,
  balanceData,
  isPending,
  onSave,
}: AutoTopUpCardProps) {
  const initialEnabled = balanceData?.autoTopUp.enabled ?? false;
  const [enabled, setEnabled] = useState(initialEnabled);
  const [threshold, setThreshold] = useState(
    String(balanceData?.autoTopUp.thresholdUsd ?? 5)
  );
  const [amount, setAmount] = useState(
    String(balanceData?.autoTopUp.amountUsd ?? 100)
  );

  const save = (overrides?: { enabled?: boolean }) => {
    onSave({
      enabled: overrides?.enabled ?? enabled,
      thresholdUsd: parseFloat(threshold) || 5,
      amountUsd: parseFloat(amount) || 100,
    });
  };

  const handleToggle = (value: boolean) => {
    setEnabled(value);
    save({ enabled: value });
  };

  const hasPaymentMethod = balanceData?.hasPaymentMethod ?? false;

  return (
    <Card>
      <CardHeader>
        <SectionHeader
          icon={RefreshCw}
          title="Auto Top-Up"
          description="Automatically add credits when your balance is low"
          action={
            hasPaymentMethod && !balanceLoading ? (
              <Switch
                checked={enabled}
                onCheckedChange={handleToggle}
                disabled={isPending}
              />
            ) : undefined
          }
        />
      </CardHeader>
      {balanceLoading ? (
        <CardContent>
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        </CardContent>
      ) : !hasPaymentMethod ? (
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Make your first top-up to save a payment method and enable auto
            top-up.
          </p>
        </CardContent>
      ) : enabled ? (
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="threshold">When balance drops below</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                  $
                </span>
                <Input
                  id="threshold"
                  type="text"
                  inputMode="decimal"
                  value={threshold}
                  onChange={(e) =>
                    setThreshold(e.target.value.replace(/[^0-9.]/g, ''))
                  }
                  onBlur={() => save()}
                  className="pl-7 tabular-nums"
                  autoComplete="off"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="recharge">Top up with</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                  $
                </span>
                <Input
                  id="recharge"
                  type="text"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) =>
                    setAmount(e.target.value.replace(/[^0-9.]/g, ''))
                  }
                  onBlur={() => save()}
                  className="pl-7 tabular-nums"
                  autoComplete="off"
                />
              </div>
            </div>
          </div>
        </CardContent>
      ) : null}
    </Card>
  );
}
