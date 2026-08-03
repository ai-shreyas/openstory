/**
 * Auto Top-Up Dialog (#1099)
 * OpenAI-style "Auto-reload credits" modal: enable toggle, threshold,
 * top-up-to target, and the resulting charge. Opened from the "Modify"
 * button in billing settings.
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
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { updateAutoTopUpFn } from '@/functions/billing';
import {
  BILLING_BALANCE_KEY,
  useBillingBalance,
} from '@/hooks/use-billing-balance';
import { BILLING_GATE_KEY } from '@/hooks/use-billing-gate';
import {
  formatPlatformFeePercent,
  MAX_TOPUP_AMOUNT_USD,
  MIN_AUTO_TOPUP_GAP_USD,
  MIN_TOPUP_AMOUNT_USD,
  splitCheckoutAmounts,
} from '@/lib/billing/constants';
import { usePostHog } from '@posthog/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

type AutoTopUpDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type AmountFieldProps = {
  id: string;
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
};

const AmountField: React.FC<AmountFieldProps> = ({
  id,
  label,
  value,
  disabled,
  onChange,
}) => (
  <div className="flex items-center justify-between gap-4">
    <Label htmlFor={id} className="shrink-0 font-normal">
      {label}
    </Label>
    <div className="relative w-40">
      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
        $
      </span>
      <Input
        id={id}
        type="text"
        inputMode="decimal"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ''))}
        className="pl-7 tabular-nums"
        autoComplete="off"
      />
    </div>
  </div>
);

export function AutoTopUpDialog({ open, onOpenChange }: AutoTopUpDialogProps) {
  const queryClient = useQueryClient();
  const posthog = usePostHog();
  const { data: balanceData } = useBillingBalance();

  const [enabled, setEnabled] = useState(false);
  const [threshold, setThreshold] = useState('5');
  const [target, setTarget] = useState('100');
  const [error, setError] = useState<string | null>(null);

  // Seed from saved settings each time the dialog opens
  useEffect(() => {
    if (!open || !balanceData) return;
    setEnabled(balanceData.autoTopUp.enabled);
    setThreshold(String(balanceData.autoTopUp.thresholdUsd ?? 5));
    setTarget(String(balanceData.autoTopUp.amountUsd ?? 100));
    setError(null);
  }, [open, balanceData]);

  const thresholdUsd = parseFloat(threshold);
  const targetUsd = parseFloat(target);
  const isValid =
    !enabled ||
    (!isNaN(thresholdUsd) &&
      !isNaN(targetUsd) &&
      thresholdUsd >= 0 &&
      targetUsd >= MIN_TOPUP_AMOUNT_USD &&
      targetUsd <= MAX_TOPUP_AMOUNT_USD &&
      targetUsd >= thresholdUsd + MIN_AUTO_TOPUP_GAP_USD);
  const chargeBreakdown =
    enabled && isValid ? splitCheckoutAmounts(targetUsd - thresholdUsd) : null;

  const mutation = useMutation({
    mutationFn: () =>
      updateAutoTopUpFn({
        data: {
          enabled,
          ...(enabled && { thresholdUsd, amountUsd: targetUsd }),
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [...BILLING_BALANCE_KEY],
      });
      void queryClient.invalidateQueries({ queryKey: [...BILLING_GATE_KEY] });
      if (enabled) {
        posthog.capture('auto_topup_enabled', {
          threshold_usd: thresholdUsd,
          amount_usd: targetUsd,
        });
      }
      toast.success(enabled ? 'Auto-reload enabled' : 'Auto-reload disabled');
      onOpenChange(false);
    },
    onError: (err) => {
      setError(
        err instanceof Error ? err.message : 'Failed to update auto-reload'
      );
    },
  });

  const handleSave = () => {
    if (!isValid) {
      setError(
        `Top-up target must be at least $${MIN_AUTO_TOPUP_GAP_USD} above the threshold (and between $${MIN_TOPUP_AMOUNT_USD} and $${MAX_TOPUP_AMOUNT_USD.toLocaleString()})`
      );
      return;
    }
    setError(null);
    mutation.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Auto-reload credits</DialogTitle>
          <DialogDescription className="sr-only">
            Automatically add credits when your balance runs low.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="auto-topup-enabled">Use auto-reload</Label>
            <Switch
              id="auto-topup-enabled"
              checked={enabled}
              onCheckedChange={(value) => {
                setEnabled(value);
                setError(null);
              }}
            />
          </div>
          <p className="text-sm text-muted-foreground">
            Automatically add credits when your balance runs low.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <AmountField
            id="auto-topup-threshold"
            label="When my balance reaches:"
            value={threshold}
            disabled={!enabled}
            onChange={(value) => {
              setThreshold(value);
              setError(null);
            }}
          />
          <AmountField
            id="auto-topup-target"
            label="Top up to:"
            value={target}
            disabled={!enabled}
            onChange={(value) => {
              setTarget(value);
              setError(null);
            }}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Separator />
          <div className="flex items-center justify-between gap-4 text-sm tabular-nums">
            <span className="text-muted-foreground">Amount charged:</span>
            <span>
              {chargeBreakdown
                ? `$${chargeBreakdown.totalUsd.toFixed(2)}`
                : '—'}
            </span>
          </div>
          {chargeBreakdown && (
            <p className="text-xs text-muted-foreground">
              Includes the {formatPlatformFeePercent()} platform fee. The exact
              charge tops your balance up to ${targetUsd.toFixed(2)}.
            </p>
          )}
          <Separator />
        </div>

        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={mutation.isPending || !isValid}
          >
            {mutation.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
