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
  subtractMicros,
  ZERO_MICROS,
} from '@/lib/billing/money';
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
import { and, count, desc, eq, gte, notExists, sql } from 'drizzle-orm';
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

type ReservationStatus =
  | 'open'
  | 'settling'
  | 'settled'
  | 'releasing'
  | 'released';

const RESERVATION_KIND = 'credit_reservation';

type ReservationMeta = {
  kind: typeof RESERVATION_KIND;
  reservationStatus: ReservationStatus;
  reservedMicros: number;
  skippedDeltaMicros?: number;
};

type TryDebitResult =
  | {
      ok: true;
      newBalance: Microdollars;
      chargedAmount: Microdollars;
      transactionId: string;
      replay: boolean;
    }
  | { ok: false };

export type ReserveCreditsResult =
  | {
      reserved: true;
      newBalance: Microdollars;
      reservedAmount: Microdollars;
      transactionId: string;
      replay: boolean;
    }
  | { reserved: false };

export type SettleReservationResult =
  | { status: 'missing' }
  | { status: 'released' }
  | { status: 'settled'; skippedDeltaMicros?: Microdollars };

export type ReleaseReservationResult =
  | { status: 'missing' }
  | { status: 'settled' }
  | { status: 'released' };

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- JSON column
    return value as Record<string, unknown>;
  }
  return {};
}

function reservationStatus(metadata: unknown): ReservationStatus | undefined {
  const status = asRecord(metadata).reservationStatus;
  if (
    status === 'open' ||
    status === 'settling' ||
    status === 'settled' ||
    status === 'releasing' ||
    status === 'released'
  ) {
    return status;
  }
  return undefined;
}

function reservedMicrosOf(
  row: { amount: number; metadata: unknown },
  fallback: Microdollars
): Microdollars {
  const raw = asRecord(row.metadata).reservedMicros;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return micros(raw);
  }
  return fallback;
}

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
      /**
       * Makes the grant replay-safe. Without it (or `stripeSessionId`) the
       * `onConflictDoNothing` below has no reachable conflict target, so a
       * retried credit is applied twice.
       */
      idempotencyKey?: string;
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

    const txType = opts.type ?? 'credit_purchase';

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
        idempotencyKey: opts.idempotencyKey ?? null,
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
      logger.error('Auto top-up failed after deduction', {
        teamId,
        balanceMicros: newBalance,
        err,
      });
    });

    return {
      newBalance,
      chargedAmount,
      transactionId,
    };
  }

  async function getTransactionByIdempotencyKey(idempotencyKey: string) {
    const [row] = await db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.teamId, teamId),
          eq(transactions.idempotencyKey, idempotencyKey)
        )
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Atomic conditional debit: `UPDATE credits SET balance = balance - n
   * WHERE balance >= n` plus a ledger row, in one `db.batch`. The INSERT
   * only lands when the UPDATE actually changed a row (`changes() > 0`),
   * so an overdraft is a no-op rather than a CHECK failure or a phantom
   * charge. Replay of the same `idempotencyKey` recovers the original row.
   */
  async function tryDebit(
    amountMicros: Microdollars,
    opts: {
      description: string;
      metadata: Record<string, unknown>;
      idempotencyKey: string;
      type?: TransactionType;
    }
  ): Promise<TryDebitResult> {
    if (amountMicros <= 0) return { ok: false };

    const existing = await getTransactionByIdempotencyKey(opts.idempotencyKey);
    if (existing) {
      const [balanceRow] = await db
        .select({ balance: credits.balance })
        .from(credits)
        .where(eq(credits.teamId, teamId))
        .limit(1);
      return {
        ok: true,
        replay: true,
        transactionId: existing.id,
        chargedAmount: micros(Math.abs(existing.amount)),
        newBalance: micros(balanceRow?.balance ?? 0),
      };
    }

    await db
      .insert(credits)
      .values({ teamId, balance: 0 })
      .onConflictDoNothing();

    const txId = generateId();
    const now = new Date();
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const txType = opts.type ?? 'credit_usage';
    const signedAmount =
      txType === 'credit_usage' ? negateMicros(amountMicros) : amountMicros;

    const updateBalance = db
      .update(credits)
      .set({
        balance: sql`${credits.balance} - ${amountMicros}`,
        updatedAt: now,
      })
      .where(
        and(
          eq(credits.teamId, teamId),
          gte(credits.balance, amountMicros),
          notExists(
            db
              .select({ id: transactions.id })
              .from(transactions)
              .where(
                and(
                  eq(transactions.teamId, teamId),
                  eq(transactions.idempotencyKey, opts.idempotencyKey)
                )
              )
          )
        )
      );

    const insertTransaction = db
      .insert(transactions)
      .select(
        db
          .select({
            id: sql<string>`${txId}`.as('id'),
            teamId: sql<string>`${teamId}`.as('team_id'),
            userId: sql<string>`${userId}`.as('user_id'),
            type: sql<string>`${txType}`.as('type'),
            amount: sql<number>`${signedAmount}`.as('amount'),
            balanceAfter: credits.balance,
            description: sql<string>`${opts.description}`.as('description'),
            metadata: sql`${JSON.stringify(opts.metadata)}`.as('metadata'),
            idempotencyKey: sql<string>`${opts.idempotencyKey}`.as(
              'idempotency_key'
            ),
            createdAt: sql`${nowSeconds}`.as('created_at'),
          })
          .from(credits)
          .where(and(eq(credits.teamId, teamId), sql`changes() > 0`))
      )
      .onConflictDoNothing()
      .returning({ id: transactions.id });

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
        `tryDebit: credits row missing for team ${teamId} after batch`
      );
    }
    const newBalance = micros(balanceRow.balance);
    const transactionId = insertedRows[0]?.id;
    if (!transactionId) {
      const raced = await getTransactionByIdempotencyKey(opts.idempotencyKey);
      if (raced) {
        return {
          ok: true,
          replay: true,
          transactionId: raced.id,
          chargedAmount: micros(Math.abs(raced.amount)),
          newBalance,
        };
      }
      return { ok: false };
    }

    await emitBalanceUpdated({
      teamId,
      newBalance,
      amountMicros: signedAmount,
      transactionId,
      type: txType,
    });

    if (txType === 'credit_usage') {
      void maybeAutoTopUp(newBalance).catch((err) => {
        logger.error('Auto top-up failed after reservation debit', {
          teamId,
          balanceMicros: newBalance,
          err,
        });
      });
    }

    return {
      ok: true,
      replay: false,
      transactionId,
      chargedAmount: amountMicros,
      newBalance,
    };
  }

  async function creditBalance(
    amountMicros: Microdollars,
    opts: {
      description: string;
      metadata: Record<string, unknown>;
      idempotencyKey: string;
    }
  ): Promise<TryDebitResult> {
    if (amountMicros <= 0) return { ok: false };

    const existing = await getTransactionByIdempotencyKey(opts.idempotencyKey);
    if (existing) {
      const [balanceRow] = await db
        .select({ balance: credits.balance })
        .from(credits)
        .where(eq(credits.teamId, teamId))
        .limit(1);
      return {
        ok: true,
        replay: true,
        transactionId: existing.id,
        chargedAmount: micros(Math.abs(existing.amount)),
        newBalance: micros(balanceRow?.balance ?? 0),
      };
    }

    await db
      .insert(credits)
      .values({ teamId, balance: 0 })
      .onConflictDoNothing();

    const txId = generateId();
    const now = new Date();
    const nowSeconds = Math.floor(now.getTime() / 1000);

    const updateBalance = db
      .update(credits)
      .set({
        balance: sql`${credits.balance} + ${amountMicros}`,
        updatedAt: now,
      })
      .where(
        and(
          eq(credits.teamId, teamId),
          notExists(
            db
              .select({ id: transactions.id })
              .from(transactions)
              .where(
                and(
                  eq(transactions.teamId, teamId),
                  eq(transactions.idempotencyKey, opts.idempotencyKey)
                )
              )
          )
        )
      );

    const insertTransaction = db
      .insert(transactions)
      .select(
        db
          .select({
            id: sql<string>`${txId}`.as('id'),
            teamId: sql<string>`${teamId}`.as('team_id'),
            userId: sql<string>`${userId}`.as('user_id'),
            type: sql<string>`${'credit_refund'}`.as('type'),
            amount: sql<number>`${amountMicros}`.as('amount'),
            balanceAfter: credits.balance,
            description: sql<string>`${opts.description}`.as('description'),
            metadata: sql`${JSON.stringify(opts.metadata)}`.as('metadata'),
            idempotencyKey: sql<string>`${opts.idempotencyKey}`.as(
              'idempotency_key'
            ),
            createdAt: sql`${nowSeconds}`.as('created_at'),
          })
          .from(credits)
          .where(and(eq(credits.teamId, teamId), sql`changes() > 0`))
      )
      .onConflictDoNothing()
      .returning({ id: transactions.id });

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
        `creditBalance: credits row missing for team ${teamId} after batch`
      );
    }
    const newBalance = micros(balanceRow.balance);
    const transactionId = insertedRows[0]?.id;
    if (!transactionId) {
      const raced = await getTransactionByIdempotencyKey(opts.idempotencyKey);
      if (raced) {
        return {
          ok: true,
          replay: true,
          transactionId: raced.id,
          chargedAmount: micros(Math.abs(raced.amount)),
          newBalance,
        };
      }
      return { ok: false };
    }

    await emitBalanceUpdated({
      teamId,
      newBalance,
      amountMicros,
      transactionId,
      type: 'credit_refund',
    });

    return {
      ok: true,
      replay: false,
      transactionId,
      chargedAmount: amountMicros,
      newBalance,
    };
  }

  async function casReservationStatus(
    transactionId: string,
    from: ReservationStatus,
    to: ReservationStatus,
    extra: Record<string, unknown> = {}
  ): Promise<boolean> {
    const skipped = extra.skippedDeltaMicros;
    const setSql =
      typeof skipped === 'number'
        ? sql`json_set(${transactions.metadata}, '$.reservationStatus', ${to}, '$.skippedDeltaMicros', ${skipped})`
        : sql`json_set(${transactions.metadata}, '$.reservationStatus', ${to})`;

    const [updated] = await db
      .update(transactions)
      .set({ metadata: setSql })
      .where(
        and(
          eq(transactions.id, transactionId),
          sql`json_extract(${transactions.metadata}, '$.reservationStatus') = ${from}`
        )
      )
      .returning({ id: transactions.id });
    return Boolean(updated);
  }

  async function tryDeductCredits(
    amountMicros: Microdollars,
    opts: {
      description?: string;
      metadata?: Record<string, unknown>;
      idempotencyKey: string;
    }
  ): Promise<TryDebitResult> {
    return tryDebit(amountMicros, {
      description:
        opts.description ?? `Usage: $${microsToUsd(amountMicros).toFixed(4)}`,
      metadata: opts.metadata ?? {},
      idempotencyKey: opts.idempotencyKey,
    });
  }

  async function reserveCredits(
    amountMicros: Microdollars,
    opts: {
      description: string;
      metadata?: Record<string, unknown>;
      idempotencyKey: string;
    }
  ): Promise<ReserveCreditsResult> {
    const metadata: ReservationMeta & Record<string, unknown> = {
      ...opts.metadata,
      kind: RESERVATION_KIND,
      reservationStatus: 'open',
      reservedMicros: amountMicros,
    };
    const result = await tryDebit(amountMicros, {
      description: opts.description,
      metadata,
      idempotencyKey: opts.idempotencyKey,
    });
    if (!result.ok) return { reserved: false };
    return {
      reserved: true,
      newBalance: result.newBalance,
      reservedAmount: result.chargedAmount,
      transactionId: result.transactionId,
      replay: result.replay,
    };
  }

  async function settleReservation(opts: {
    reservationKey: string;
    settleKey: string;
    actualCostMicros: Microdollars;
    description?: string;
    metadata?: Record<string, unknown>;
  }): Promise<SettleReservationResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const reservation = await getTransactionByIdempotencyKey(
        opts.reservationKey
      );
      if (!reservation) return { status: 'missing' };

      const status = reservationStatus(reservation.metadata);
      if (status === 'settled') {
        const skipped = asRecord(reservation.metadata).skippedDeltaMicros;
        return typeof skipped === 'number' && skipped > 0
          ? { status: 'settled', skippedDeltaMicros: micros(skipped) }
          : { status: 'settled' };
      }
      if (status === 'released' || status === 'releasing') {
        return { status: 'released' };
      }

      if (status === 'open') {
        const claimed = await casReservationStatus(
          reservation.id,
          'open',
          'settling'
        );
        if (!claimed) continue;
      } else if (status !== 'settling') {
        continue;
      }

      const reservedAmount = reservedMicrosOf(
        reservation,
        micros(Math.abs(reservation.amount))
      );
      const actual = opts.actualCostMicros;
      const delta = subtractMicros(actual, reservedAmount);
      let skippedDeltaMicros: Microdollars | undefined;

      if (delta > 0) {
        const extra = await tryDebit(delta, {
          description:
            opts.description ??
            reservation.description ??
            `Usage: $${microsToUsd(delta).toFixed(4)}`,
          metadata: {
            kind: 'credit_reservation_settle',
            ...opts.metadata,
          },
          idempotencyKey: opts.settleKey,
        });
        if (!extra.ok) skippedDeltaMicros = delta;
      } else if (delta < 0) {
        await creditBalance(negateMicros(delta), {
          description:
            opts.description ?? reservation.description ?? 'Unused reservation',
          metadata: {
            kind: 'credit_reservation_settle',
            ...opts.metadata,
          },
          idempotencyKey: opts.settleKey,
        });
      }

      await casReservationStatus(
        reservation.id,
        'settling',
        'settled',
        skippedDeltaMicros ? { skippedDeltaMicros } : {}
      );

      return skippedDeltaMicros
        ? { status: 'settled', skippedDeltaMicros }
        : { status: 'settled' };
    }

    throw new Error(
      `settleReservation: could not claim reservation ${opts.reservationKey} for team ${teamId}`
    );
  }

  async function releaseReservation(opts: {
    reservationKey: string;
    releaseKey: string;
  }): Promise<ReleaseReservationResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const reservation = await getTransactionByIdempotencyKey(
        opts.reservationKey
      );
      if (!reservation) return { status: 'missing' };

      const status = reservationStatus(reservation.metadata);
      if (status === 'settled' || status === 'settling') {
        return { status: 'settled' };
      }
      if (status === 'released') {
        return { status: 'released' };
      }

      if (status === 'open') {
        const claimed = await casReservationStatus(
          reservation.id,
          'open',
          'releasing'
        );
        if (!claimed) continue;
      } else if (status !== 'releasing') {
        continue;
      }

      const reservedAmount = reservedMicrosOf(
        reservation,
        micros(Math.abs(reservation.amount))
      );
      await creditBalance(reservedAmount, {
        description: reservation.description
          ? `Released: ${reservation.description}`
          : 'Released reservation',
        metadata: { kind: 'credit_reservation_release' },
        idempotencyKey: opts.releaseKey,
      });

      await casReservationStatus(reservation.id, 'releasing', 'released');
      return { status: 'released' };
    }

    throw new Error(
      `releaseReservation: could not claim reservation ${opts.reservationKey} for team ${teamId}`
    );
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

    // `== null`, not falsy: a threshold of 0 ("top up when I hit zero") is a
    // legitimate setting, and treating it as "unset" would silently disable
    // auto-top-up for a team whose settings page says it is on.
    if (
      !settings.autoTopUpEnabled ||
      !settings.stripeCustomerId ||
      settings.autoTopUpThresholdMicros == null ||
      settings.autoTopUpAmountMicros == null
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

    const topUpMicros = micros(settings.autoTopUpAmountMicros);

    // Dynamic import: this module is in the client module graph (via
    // middleware → scoped), and a static `stripe` import ships the Stripe
    // Node SDK to the browser (#1253). Only the server ever runs this path.
    const { getStripeOrThrow } = await import('@/lib/billing/stripe');
    const stripe = getStripeOrThrow();
    const amountCents = totalCheckoutCents(topUpMicros);

    // Every exit below leaves auto-top-up silently dead for this team while
    // the settings page still advertises it as on — so each one logs (#1099).
    const customer = await stripe.customers.retrieve(settings.stripeCustomerId);
    if (customer.deleted) {
      logger.warn('Auto top-up skipped: Stripe customer deleted', {
        teamId,
        stripeCustomerId: settings.stripeCustomerId,
      });
      return;
    }

    const defaultPaymentMethod =
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      customer.invoice_settings?.default_payment_method;
    if (!defaultPaymentMethod) {
      logger.warn('Auto top-up skipped: no default payment method', {
        teamId,
        stripeCustomerId: settings.stripeCustomerId,
      });
      return;
    }

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
      // userId is required by stripeWebhookMiddleware — without it every
      // payment_intent.* webhook for this charge is rejected with a 400.
      metadata: {
        teamId,
        userId,
        type: 'auto_top_up',
      },
    });

    if (paymentIntent.status !== 'succeeded') {
      // Declines and SCA (`requires_action`) are the common off-session
      // outcomes. Nothing downstream retries, so this is the only record that
      // auto-top-up has stopped working for this team.
      logger.error('Auto top-up payment did not succeed', {
        teamId,
        status: paymentIntent.status,
        amountCents,
        stripePaymentIntentId: paymentIntent.id,
      });
      return;
    }

    const charge = paymentIntent.latest_charge;
    const receiptUrl =
      charge && typeof charge === 'object' ? charge.receipt_url : undefined;

    await addCredits(topUpMicros, {
      description: `Auto top-up: ${microsToDisplayUsd(topUpMicros)}`,
      metadata: {
        stripePaymentIntentId: paymentIntent.id,
        autoTopUp: true,
        ...(receiptUrl && { receiptUrl }),
      },
    });
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
    tryDeductCredits,
    reserveCredits,
    settleReservation,
    releaseReservation,
    updateAutoTopUpSettings,
    checkAutoTopUp,
    reconcileBatchBalance,
    redeemGiftToken,
  };
}
