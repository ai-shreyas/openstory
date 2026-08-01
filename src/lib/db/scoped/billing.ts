/**
 * Scoped Billing Sub-module
 * Team-scoped credit operations: balance, deductions, transactions, settings.
 * All monetary values are in Microdollars (1 USD = 1,000,000).
 */

import {
  AUTO_TOPUP_COOLDOWN_MS,
  calculateExpiryDate,
  isStripeEnabled,
  MIN_TOPUP_AMOUNT_MICROS,
  totalCheckoutCents,
} from '@/lib/billing/constants';
import {
  type Microdollars,
  micros,
  microsToDisplayUsd,
  microsToUsd,
  negateMicros,
  ZERO_MICROS,
} from '@/lib/billing/money';
import { getStripeOrThrow } from '@/lib/billing/stripe';
import type { Database } from '@/lib/db/client';
import {
  creditBatches,
  credits,
  teamBillingSettings,
  transactions,
} from '@/lib/db/schema/credits';
import type {
  CreditBatchSource,
  TeamBillingSetting,
  TransactionType,
} from '@/lib/db/schema/credits';
import { ValidationError } from '@/lib/errors';
import { getBillingChannel } from '@/lib/realtime';
import { and, count, desc, eq, notExists, sql } from 'drizzle-orm';
import { generateId } from '../id';
import { giftTokenRedemptions, giftTokens } from '../schema';

import { getLogger } from '@/lib/observability/logger';

/**
 * Best-effort live balance push for the credit pill (#1090).
 *
 * **Awaited** (emit itself never throws): request-scoped paths like enhance
 * script finish the streaming response right after `deductCredits`, and a
 * fire-and-forget DO fetch can be dropped when the isolate tears down.
 * Call only after a *new* transaction row was inserted (not on idempotent
 * replay).
 */
async function emitBalanceUpdated(opts: {
  teamId: string;
  newBalance: Microdollars;
  /** Signed ledger amount (negative for usage). */
  amountMicros: Microdollars;
  transactionId: string;
  type: TransactionType;
}): Promise<void> {
  await getBillingChannel(opts.teamId).emit('billing.balance:updated', {
    teamId: opts.teamId,
    balanceUsd: microsToUsd(opts.newBalance),
    amountUsd: microsToUsd(opts.amountMicros),
    transactionId: opts.transactionId,
    type: opts.type,
  });
}

const logger = getLogger(['openstory', 'db', 'billing']);

function mapBatchSource(
  type: TransactionType,
  metadata?: Record<string, unknown>
): CreditBatchSource {
  if (metadata?.giftTokenId) return 'gift_code';
  if (metadata?.autoTopUp) return 'auto_topup';
  if (type === 'credit_adjustment') return 'adjustment';
  return 'stripe_checkout';
}

/**
 * Read-only billing methods — balance checks, transaction history, settings.
 */
function createBillingReadMethods(db: Database, teamId: string) {
  async function getBalance(): Promise<Microdollars> {
    const [row] = await db
      .select({ balance: credits.balance })
      .from(credits)
      .where(eq(credits.teamId, teamId))
      .limit(1);

    if (!row) {
      await db
        .insert(credits)
        .values({ teamId, balance: 0 })
        .onConflictDoNothing({ target: credits.teamId });
      return ZERO_MICROS;
    }

    return micros(row.balance);
  }

  async function hasEnoughCredits(
    estimatedCostMicros: Microdollars
  ): Promise<boolean> {
    const balance = await getBalance();
    return balance >= estimatedCostMicros;
  }

  async function getTransactionHistory(
    opts: { limit?: number; offset?: number; type?: TransactionType } = {}
  ): Promise<{
    transactions: Array<{
      id: string;
      type: string;
      amount: number;
      balanceAfter: number;
      description: string | null;
      metadata: unknown;
      createdAt: Date;
    }>;
    total: number;
  }> {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    const conditions = [eq(transactions.teamId, teamId)];
    if (opts.type) {
      conditions.push(eq(transactions.type, opts.type));
    }
    const whereClause =
      conditions.length === 1 ? conditions[0] : and(...conditions);

    const [rows, countResult] = await Promise.all([
      db
        .select({
          id: transactions.id,
          type: transactions.type,
          amount: transactions.amount,
          balanceAfter: transactions.balanceAfter,
          description: transactions.description,
          metadata: transactions.metadata,
          createdAt: transactions.createdAt,
        })
        .from(transactions)
        .where(whereClause)
        .orderBy(desc(transactions.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)` })
        .from(transactions)
        .where(whereClause),
    ]);

    const total = countResult[0]?.count ?? 0;
    return { transactions: rows, total };
  }

  async function getBillingSettings(): Promise<TeamBillingSetting> {
    const [row] = await db
      .select()
      .from(teamBillingSettings)
      .where(eq(teamBillingSettings.teamId, teamId))
      .limit(1);

    if (row) return row;

    const [inserted] = await db
      .insert(teamBillingSettings)
      .values({ teamId })
      .onConflictDoNothing({ target: teamBillingSettings.teamId })
      .returning();

    if (inserted) return inserted;

    // Lost the race — peer inserted between our SELECT and INSERT.
    const [existing] = await db
      .select()
      .from(teamBillingSettings)
      .where(eq(teamBillingSettings.teamId, teamId))
      .limit(1);
    if (!existing) {
      throw new Error(
        `getBillingSettings: row missing for team ${teamId} after onConflictDoNothing`
      );
    }
    return existing;
  }

  return {
    getBalance,
    hasEnoughCredits,
    getTransactionHistory,
    getBillingSettings,
  };
}

/**
 * Full billing methods — extends read methods with writes that auto-inject userId.
 */
export function createBillingMethods(
  db: Database,
  teamId: string,
  userId: string
) {
  const read = createBillingReadMethods(db, teamId);

  async function addCredits(
    amountMicros: Microdollars,
    opts: {
      type?: TransactionType;
      description?: string;
      metadata?: Record<string, unknown>;
      stripeSessionId?: string;
    } = {}
  ): Promise<{ newBalance: Microdollars; transactionId: string } | null> {
    if (amountMicros <= 0) {
      throw new ValidationError('Credit amount must be positive');
    }

    await db
      .insert(credits)
      .values({ teamId, balance: 0 })
      .onConflictDoNothing();

    const [updated] = await db
      .update(credits)
      .set({
        balance: sql`${credits.balance} + ${amountMicros}`,
        updatedAt: new Date(),
      })
      .where(eq(credits.teamId, teamId))
      .returning({ balance: credits.balance });

    if (!updated) {
      throw new Error(`addCredits: update returned no row for team ${teamId}`);
    }

    const txType = opts.type ?? ('credit_purchase' as TransactionType);

    const rows = await db
      .insert(transactions)
      .values({
        teamId,
        userId,
        type: txType,
        amount: amountMicros,
        balanceAfter: updated.balance,
        description:
          opts.description ??
          `Added ${microsToDisplayUsd(amountMicros)} credits`,
        metadata: opts.metadata ?? {},
        stripeSessionId: opts.stripeSessionId ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: transactions.id });

    if (rows.length === 0) {
      await db
        .update(credits)
        .set({
          balance: sql`${credits.balance} - ${amountMicros}`,
          updatedAt: new Date(),
        })
        .where(eq(credits.teamId, teamId));
      return null;
    }

    const insertedRow = rows[0];
    if (!insertedRow) {
      throw new Error(
        `addCredits: transaction insert returned no row for team ${teamId}`
      );
    }
    const transactionId = insertedRow.id;

    await db.insert(creditBatches).values({
      teamId,
      originalAmount: amountMicros,
      remainingAmount: amountMicros,
      source: mapBatchSource(txType, opts.metadata),
      transactionId,
      expiresAt: calculateExpiryDate(),
    });

    const newBalance = micros(updated.balance);
    await emitBalanceUpdated({
      teamId,
      newBalance,
      amountMicros,
      transactionId,
      type: txType,
    });

    return { newBalance, transactionId };
  }

  async function saveStripeCustomerId(stripeCustomerId: string): Promise<void> {
    await db
      .insert(teamBillingSettings)
      .values({ teamId, stripeCustomerId })
      .onConflictDoUpdate({
        target: teamBillingSettings.teamId,
        set: {
          stripeCustomerId,
          updatedAt: new Date(),
        },
      });
  }

  /**
   * Charges provider cost at face value (no usage fee). Triggers auto-top-up if balance drops below
   * threshold.
   *
   * Pass `opts.idempotencyKey` (convention: `${workflowInstanceId}:<charge-name>`)
   * from any retryable context — a workflow `step.do` that throws partway
   * re-runs its closure, and without the key every replay double-debits the
   * team and writes a duplicate ledger row. The balance UPDATE and the
   * transaction INSERT run in one atomic `db.batch`; the UPDATE is guarded on
   * "no transaction with this key exists yet" and the INSERT dedupes via the
   * partial unique index on `(team_id, idempotency_key)`. A replay is a no-op
   * that returns the original transaction id — note that on a replay the
   * returned `chargedAmount` is what the ORIGINAL attempt charged; nothing
   * was debited by this call (don't emit "charged $X" side effects from it).
   */
  async function deductCredits(
    rawCostMicros: Microdollars,
    opts: {
      description?: string;
      metadata?: Record<string, unknown>;
      idempotencyKey?: string;
    } = {}
  ): Promise<{
    newBalance: Microdollars;
    chargedAmount: Microdollars;
    transactionId: string;
  }> {
    if (rawCostMicros <= 0)
      return {
        newBalance: await read.getBalance(),
        chargedAmount: ZERO_MICROS,
        transactionId: '',
      };

    const chargedAmount = rawCostMicros;
    const { idempotencyKey } = opts;

    await db
      .insert(credits)
      .values({ teamId, balance: 0 })
      .onConflictDoNothing();

    const chargedUsd = microsToUsd(chargedAmount);

    const updateBalance = db
      .update(credits)
      .set({
        balance: sql`${credits.balance} - ${chargedAmount}`,
        updatedAt: new Date(),
      })
      .where(
        idempotencyKey
          ? and(
              eq(credits.teamId, teamId),
              notExists(
                db
                  .select({ id: transactions.id })
                  .from(transactions)
                  .where(
                    and(
                      eq(transactions.teamId, teamId),
                      eq(transactions.idempotencyKey, idempotencyKey)
                    )
                  )
              )
            )
          : eq(credits.teamId, teamId)
      );

    // balanceAfter reads the post-UPDATE balance via subquery — the batch
    // statements run sequentially inside one transaction, so this sees the
    // decremented value. On a replay the INSERT no-ops, so the (stale) value
    // is never written.
    const insertTransaction = db
      .insert(transactions)
      .values({
        teamId,
        userId,
        type: 'credit_usage' as TransactionType,
        amount: negateMicros(chargedAmount),
        balanceAfter: sql`(select ${credits.balance} from ${credits} where ${credits.teamId} = ${teamId})`,
        description: opts.description ?? `Usage: $${chargedUsd.toFixed(4)}`,
        metadata: {
          costMicros: chargedAmount,
          ...opts.metadata,
        },
        idempotencyKey: idempotencyKey ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: transactions.id });

    // Third statement: re-read the balance to return to the caller. Distinct
    // from the `balanceAfter` ledger column above (that one is persisted into
    // the transaction row; this one is the authoritative read-back, correct
    // even on a replay where the UPDATE no-ops) — both rely on running after
    // `updateBalance` inside the same batch transaction, so don't "optimize"
    // either away in favor of the other.
    const readBackBalance = db
      .select({ balance: credits.balance })
      .from(credits)
      .where(eq(credits.teamId, teamId));

    const [, insertedRows, balanceRows] = await db.batch([
      updateBalance,
      insertTransaction,
      readBackBalance,
    ]);

    const balanceRow = balanceRows[0];
    if (!balanceRow) {
      throw new Error(
        `deductCredits: credits row missing for team ${teamId} after batch`
      );
    }
    const newBalance = micros(balanceRow.balance);

    let transactionId = insertedRows[0]?.id;
    // True only when this call wrote the ledger row — not an idempotent replay.
    // Don't fire "charged $X" side effects (realtime) on replay.
    const isNewCharge = Boolean(transactionId);
    if (!transactionId) {
      if (!idempotencyKey) {
        throw new Error(
          `deductCredits: transaction insert returned no row for team ${teamId}`
        );
      }
      // Replay of an already-applied deduction — recover the original
      // transaction id. Must not throw: the charge landed on a prior attempt.
      const [existing] = await db
        .select({ id: transactions.id })
        .from(transactions)
        .where(
          and(
            eq(transactions.teamId, teamId),
            eq(transactions.idempotencyKey, idempotencyKey)
          )
        )
        .limit(1);
      if (!existing) {
        throw new Error(
          `deductCredits: no transaction row for team ${teamId} key ${idempotencyKey} after conflict no-op`
        );
      }
      transactionId = existing.id;
    }

    if (isNewCharge) {
      await emitBalanceUpdated({
        teamId,
        newBalance,
        amountMicros: negateMicros(chargedAmount),
        transactionId,
        type: 'credit_usage',
      });
    }

    void maybeAutoTopUp(newBalance).catch((err) => {
      logger.error('Failed:', { err });
    });

    return {
      newBalance,
      chargedAmount,
      transactionId,
    };
  }

  async function updateAutoTopUpSettings(settings: {
    enabled: boolean;
    thresholdMicros?: Microdollars;
    amountMicros?: Microdollars;
  }): Promise<void> {
    if (
      settings.amountMicros !== undefined &&
      settings.amountMicros < MIN_TOPUP_AMOUNT_MICROS
    ) {
      throw new ValidationError(
        `Auto top-up amount must be at least ${microsToDisplayUsd(MIN_TOPUP_AMOUNT_MICROS)}`
      );
    }

    if (
      settings.enabled &&
      settings.thresholdMicros !== undefined &&
      settings.amountMicros !== undefined &&
      settings.amountMicros <= settings.thresholdMicros
    ) {
      throw new ValidationError(
        'Auto top-up amount must be greater than the threshold'
      );
    }

    await db
      .insert(teamBillingSettings)
      .values({
        teamId,
        autoTopUpEnabled: settings.enabled,
        autoTopUpThresholdMicros: settings.thresholdMicros,
        autoTopUpAmountMicros: settings.amountMicros,
      })
      .onConflictDoUpdate({
        target: teamBillingSettings.teamId,
        set: {
          autoTopUpEnabled: settings.enabled,
          ...(settings.thresholdMicros !== undefined && {
            autoTopUpThresholdMicros: settings.thresholdMicros,
          }),
          ...(settings.amountMicros !== undefined && {
            autoTopUpAmountMicros: settings.amountMicros,
          }),
          updatedAt: new Date(),
        },
      });
  }

  async function maybeAutoTopUp(currentBalance: Microdollars): Promise<void> {
    if (!isStripeEnabled()) return;

    const settings = await read.getBillingSettings();

    if (
      !settings.autoTopUpEnabled ||
      !settings.stripeCustomerId ||
      !settings.autoTopUpThresholdMicros ||
      !settings.autoTopUpAmountMicros
    ) {
      return;
    }

    if (currentBalance > settings.autoTopUpThresholdMicros) {
      return;
    }

    const [recentAutoTopUp] = await db
      .select({ createdAt: transactions.createdAt })
      .from(transactions)
      .where(
        and(
          eq(transactions.teamId, teamId),
          sql`json_extract(${transactions.metadata}, '$.autoTopUp') = true`
        )
      )
      .orderBy(desc(transactions.createdAt))
      .limit(1);

    if (recentAutoTopUp) {
      const elapsed = Date.now() - recentAutoTopUp.createdAt.getTime();
      if (elapsed < AUTO_TOPUP_COOLDOWN_MS) {
        logger.info(
          `Cooldown active for team ${teamId}, skipping (${Math.round(elapsed / 1000)}s ago)`
        );
        return;
      }
    }

    const stripe = getStripeOrThrow();
    const amountCents = totalCheckoutCents(
      micros(settings.autoTopUpAmountMicros)
    );

    const customer = await stripe.customers.retrieve(settings.stripeCustomerId);
    if (customer.deleted) return;

    const defaultPaymentMethod =
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      customer.invoice_settings?.default_payment_method;
    if (!defaultPaymentMethod) return;

    const paymentMethodId =
      typeof defaultPaymentMethod === 'string'
        ? defaultPaymentMethod
        : defaultPaymentMethod.id;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      customer: settings.stripeCustomerId,
      payment_method: paymentMethodId,
      off_session: true,
      confirm: true,
      expand: ['latest_charge'],
      metadata: {
        teamId,
        type: 'auto_top_up',
      },
    });

    if (paymentIntent.status === 'succeeded') {
      const charge = paymentIntent.latest_charge;
      const receiptUrl =
        charge && typeof charge === 'object' ? charge.receipt_url : undefined;

      const topUpMicros = micros(settings.autoTopUpAmountMicros);
      await addCredits(topUpMicros, {
        description: `Auto top-up: ${microsToDisplayUsd(topUpMicros)}`,
        metadata: {
          stripePaymentIntentId: paymentIntent.id,
          autoTopUp: true,
          ...(receiptUrl && { receiptUrl }),
        },
      });
    }
  }

  async function checkAutoTopUp(): Promise<void> {
    const balance = await read.getBalance();
    await maybeAutoTopUp(balance);
  }

  /** Sum active (non-expired) batch remainingAmounts and compare to credits.balance */
  async function reconcileBatchBalance(): Promise<{
    runningBalance: Microdollars;
    batchTotal: Microdollars;
    drift: number;
  }> {
    const [balanceRow] = await db
      .select({ balance: credits.balance })
      .from(credits)
      .where(eq(credits.teamId, teamId))
      .limit(1);

    const runningBalance = micros(balanceRow?.balance ?? 0);

    const [batchRow] = await db
      .select({
        total: sql<number>`COALESCE(SUM(${creditBatches.remainingAmount}), 0)`,
      })
      .from(creditBatches)
      .where(eq(creditBatches.teamId, teamId));

    const batchTotal = micros(batchRow?.total ?? 0);

    return {
      runningBalance,
      batchTotal,
      drift: runningBalance - batchTotal,
    };
  }

  /**
   * Redeem a gift token for a team. Adds credits via the billing sub-module.
   * Caller must provide an addCredits function (from billing sub-module) to avoid
   * circular dependency.
   */
  async function redeemGiftToken(opts: {
    code: string;
    teamId: string;
    userId: string;
    addCredits: (
      amountMicros: Microdollars,
      creditOpts: {
        type?: TransactionType;
        description?: string;
        metadata?: Record<string, unknown>;
      }
    ) => Promise<{ newBalance: Microdollars; transactionId: string } | null>;
  }): Promise<{ newBalance: number; amountUsd: number }> {
    const normalizedCode = opts.code.trim().toUpperCase();

    // Find the token
    const [token] = await db
      .select()
      .from(giftTokens)
      .where(eq(giftTokens.code, normalizedCode))
      .limit(1);

    if (!token) {
      throw new ValidationError('Invalid gift code');
    }

    if (token.expiresAt && token.expiresAt < new Date()) {
      throw new ValidationError('This gift code has expired');
    }

    // Count existing redemptions
    const [redemptionRow] = await db
      .select({ value: count() })
      .from(giftTokenRedemptions)
      .where(eq(giftTokenRedemptions.giftTokenId, token.id));

    const redemptionCount = redemptionRow?.value ?? 0;

    if (redemptionCount >= token.maxRedemptions) {
      throw new ValidationError('This gift code has been fully redeemed');
    }

    // Record redemption -- unique index on (giftTokenId, teamId) prevents duplicates
    const [inserted] = await db
      .insert(giftTokenRedemptions)
      .values({
        id: generateId(),
        giftTokenId: token.id,
        teamId: opts.teamId,
        userId: opts.userId,
      })
      .onConflictDoNothing()
      .returning();

    if (!inserted) {
      throw new ValidationError(
        'Your team has already redeemed this gift code'
      );
    }

    const amountMicros = micros(token.amountMicros);

    // Add credits to team
    const result = await opts.addCredits(amountMicros, {
      type: 'credit_adjustment',
      description: `Gift code redeemed: ${normalizedCode} (${microsToDisplayUsd(amountMicros)})`,
      metadata: { giftTokenId: token.id, giftCode: normalizedCode },
    });

    return {
      newBalance: result ? microsToUsd(result.newBalance) : 0,
      amountUsd: microsToUsd(amountMicros),
    };
  }
  return {
    ...read,
    addCredits,
    saveStripeCustomerId,
    deductCredits,
    updateAutoTopUpSettings,
    checkAutoTopUp,
    reconcileBatchBalance,
    redeemGiftToken,
  };
}
