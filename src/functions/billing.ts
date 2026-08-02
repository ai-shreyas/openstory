/**
 * Billing Server Functions
 * Balance, checkout, transactions, and auto-top-up
 */

import { requireTeamAdminAccess } from '@/lib/auth/action-utils';
import { createCheckoutSession } from '@/lib/billing/checkout';
import { isStripeEnabled, MIN_TOPUP_AMOUNT_USD } from '@/lib/billing/constants';
import {
  micros,
  microsToDisplayUsd,
  microsToUsd,
  usdToMicros,
} from '@/lib/billing/money';
import type { TransactionType } from '@/lib/db/schema/credits';
import { ValidationError } from '@/lib/errors';
import { FOUNDER_EMAIL } from '@/lib/marketing/constants';
import { captureProductEvent } from '@/lib/observability/product-events';
import { sendFounderCreditRequestEmail } from '@/lib/services/email-service';
import { getServerAppUrl } from '@/lib/utils/environment';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithTeamMiddleware } from './middleware';

const checkoutInputSchema = z.object({
  amountUsd: z.number().min(MIN_TOPUP_AMOUNT_USD),
});

export const createCheckoutSessionFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(zodValidator(checkoutInputSchema))
  .handler(async ({ data, context }) => {
    if (!isStripeEnabled()) {
      throw new ValidationError('Stripe is not configured');
    }

    const req = getRequest();
    const appUrl = getServerAppUrl(req);

    const { url } = await createCheckoutSession({
      scopedDb: context.scopedDb,
      teamId: context.teamId,
      amountUsd: data.amountUsd,
      userId: context.user.id,
      userEmail: context.user.email,
      successUrl: `${appUrl}/credits?success=true`,
      cancelUrl: `${appUrl}/credits?canceled=true`,
    });

    return { url };
  });

// ============================================================================
// Balance
// ============================================================================

export const getBillingBalanceFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .handler(async ({ context }) => {
    const { scopedDb } = context;

    const [balance, settings] = await Promise.all([
      scopedDb.billing.getBalance(),
      scopedDb.billing.getBillingSettings(),
    ]);

    return {
      teamId: context.teamId,
      balance: microsToUsd(balance),
      stripeEnabled: isStripeEnabled(),
      autoTopUp: {
        enabled: settings.autoTopUpEnabled,
        thresholdUsd: settings.autoTopUpThresholdMicros
          ? microsToUsd(micros(settings.autoTopUpThresholdMicros))
          : null,
        amountUsd: settings.autoTopUpAmountMicros
          ? microsToUsd(micros(settings.autoTopUpAmountMicros))
          : null,
      },
      hasPaymentMethod: !!settings.stripeCustomerId,
    };
  });

// ============================================================================
// Founder credit request ("Ask Tom for Credits", #1096)
// ============================================================================

export const requestFounderCreditsFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .handler(async ({ context }) => {
    const balance = await context.scopedDb.billing.getBalance();
    const balanceDisplay = microsToDisplayUsd(balance);

    const result = await sendFounderCreditRequestEmail({
      to: FOUNDER_EMAIL,
      userName: context.user.name,
      userEmail: context.user.email,
      teamId: context.teamId,
      balanceDisplay,
    });

    // Fired regardless of email outcome — the PostHog → Slack alert (#1088)
    // is the backup channel when email delivery fails.
    captureProductEvent({
      distinctId: context.user.id,
      event: 'founder_credits_requested',
      properties: {
        teamId: context.teamId,
        userEmail: context.user.email,
        balance: balanceDisplay,
        emailSent: result.success,
      },
    });

    if (!result.success) {
      throw new ValidationError(
        `Couldn't send your request — email ${FOUNDER_EMAIL} directly.`
      );
    }

    return { success: true };
  });

// ============================================================================
// Transactions
// ============================================================================

const VALID_TRANSACTION_TYPES: readonly TransactionType[] = [
  'credit_purchase',
  'credit_usage',
  'credit_adjustment',
  'credit_refund',
];

function isTransactionType(value: string): value is TransactionType {
  return (VALID_TRANSACTION_TYPES as readonly string[]).includes(value);
}

const transactionsInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
  type: z.string().optional(),
});

type TransactionMetadata = { receiptUrl?: string } | null;

function parseTransactionMetadata(raw: unknown): TransactionMetadata {
  if (raw == null || typeof raw !== 'object') return null;
  const obj = raw;
  return {
    ...('receiptUrl' in obj &&
      typeof obj.receiptUrl === 'string' && { receiptUrl: obj.receiptUrl }),
  };
}

type Transaction = {
  id: string;
  type: string;
  amount: number;
  balanceAfter: number;
  description: string | null;
  metadata: TransactionMetadata;
  createdAt: Date;
};

export const getTransactionsFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(zodValidator(transactionsInputSchema))
  .handler(
    async ({
      data,
      context,
    }): Promise<{
      transactions: Transaction[];
      total: number;
    }> => {
      const type =
        data.type && isTransactionType(data.type) ? data.type : undefined;

      const result = await context.scopedDb.billing.getTransactionHistory({
        limit: data.limit,
        offset: data.offset,
        ...(type && { type }),
      });

      const transactions = result.transactions.map((tx) => ({
        ...tx,
        amount: microsToUsd(micros(tx.amount)),
        balanceAfter: microsToUsd(micros(tx.balanceAfter)),
        metadata: parseTransactionMetadata(tx.metadata),
      }));

      return { transactions, total: result.total };
    }
  );

// ============================================================================
// Auto Top-Up
// ============================================================================

const autoTopUpInputSchema = z.object({
  enabled: z.boolean(),
  thresholdUsd: z.number().optional(),
  amountUsd: z.number().optional(),
});

export const updateAutoTopUpFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(zodValidator(autoTopUpInputSchema))
  .handler(async ({ data, context }) => {
    if (!isStripeEnabled()) {
      throw new ValidationError('Stripe is not configured');
    }

    await requireTeamAdminAccess(context.user.id, context.teamId);

    const billingSettings = await context.scopedDb.billing.getBillingSettings();

    if (!billingSettings.stripeCustomerId) {
      throw new ValidationError(
        'Add a payment method first by making a top-up purchase'
      );
    }

    await context.scopedDb.billing.updateAutoTopUpSettings({
      enabled: data.enabled,
      thresholdMicros:
        data.thresholdUsd !== undefined
          ? usdToMicros(data.thresholdUsd)
          : undefined,
      amountMicros:
        data.amountUsd !== undefined ? usdToMicros(data.amountUsd) : undefined,
    });

    return {
      message: data.enabled ? 'Auto top-up enabled' : 'Auto top-up disabled',
    };
  });
