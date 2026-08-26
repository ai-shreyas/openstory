/**
 * Auto-top-up: when the balance falls to the threshold, charge the saved card
 * off-session for a flat configured amount and credit it (#1099).
 */

import { micros } from '@/lib/billing/money';
import type { Database } from '@/lib/db/client';
import { generateId } from '@/lib/db/id';
import {
  creditReservations,
  credits,
  teamBillingSettings,
  teams,
  transactions,
  user,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import { type Client, createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import * as realConstants from '@/lib/billing/constants';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const paymentIntentCreate = vi.fn();

vi.doMock('@/lib/billing/constants', () => ({
  ...realConstants,
  isStripeEnabled: () => true,
}));

vi.doMock('@/lib/billing/stripe', () => ({
  getStripeOrThrow: () => ({
    customers: {
      retrieve: vi.fn().mockResolvedValue({
        deleted: false,
        invoice_settings: { default_payment_method: 'pm_1' },
      }),
    },
    paymentIntents: { create: paymentIntentCreate },
  }),
}));

const { createBillingMethods } = await import('./billing');

let client: Client;
let db: Database;
let teamId = '';
let userId = '';

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await db.delete(transactions);
  await db.delete(creditReservations);
  await db.delete(teamBillingSettings);
  await db.delete(credits);
  await db.delete(teams);
  await db.delete(user);

  teamId = generateId();
  userId = generateId();
  await db.insert(teams).values({ id: teamId, name: 'T', slug: 't' });
  await db
    .insert(user)
    .values({ id: userId, name: 'U', email: `${userId}@example.com` });
});

async function seedSettings(overrides: {
  balance: number;
  thresholdMicros: number | null;
  amountMicros?: number;
}) {
  await db.insert(credits).values({ teamId, balance: overrides.balance });
  await db.insert(teamBillingSettings).values({
    teamId,
    stripeCustomerId: 'cus_1',
    autoTopUpEnabled: true,
    autoTopUpThresholdMicros: overrides.thresholdMicros,
    autoTopUpAmountMicros: overrides.amountMicros ?? 100_000_000,
  });
}

function balanceOf() {
  return db
    .select({ balance: credits.balance })
    .from(credits)
    .where(eq(credits.teamId, teamId))
    .then(([row]) => row?.balance);
}

describe('maybeAutoTopUp', () => {
  it('charges the configured amount and credits it', async () => {
    await seedSettings({ balance: 3_000_000, thresholdMicros: 5_000_000 });

    paymentIntentCreate.mockResolvedValue({
      id: 'pi_1',
      status: 'succeeded',
      latest_charge: { receipt_url: 'https://receipt' },
    });

    const billing = createBillingMethods(db, teamId, userId);
    await billing.checkAutoTopUp();

    // $100 credited + 7% fee → $107.00 charged
    expect(paymentIntentCreate).toHaveBeenCalledTimes(1);
    expect(paymentIntentCreate.mock.calls[0]?.[0]).toMatchObject({
      amount: 10_700,
      customer: 'cus_1',
      payment_method: 'pm_1',
      off_session: true,
    });

    expect(await balanceOf()).toBe(103_000_000); // $3 + $100
  });

  it('does not charge when the balance is above the threshold', async () => {
    await seedSettings({ balance: 50_000_000, thresholdMicros: 5_000_000 });

    const billing = createBillingMethods(db, teamId, userId);
    await billing.checkAutoTopUp();

    expect(paymentIntentCreate).not.toHaveBeenCalled();
  });

  it('charges when available funds are below the threshold even if posted is not', async () => {
    // Posted $6, $5 held → available $1, threshold $5. Auto-top-up used to
    // key off posted and skip while the pill showed $1.
    await seedSettings({ balance: 6_000_000, thresholdMicros: 5_000_000 });
    paymentIntentCreate.mockResolvedValue({
      id: 'pi_1',
      status: 'succeeded',
      latest_charge: null,
    });

    const billing = createBillingMethods(db, teamId, userId);
    const held = await billing.createReservation(micros(5_000_000), {
      idempotencyKey: 'hold-1',
    });
    expect(held.ok).toBe(true);

    await billing.checkAutoTopUp();

    expect(paymentIntentCreate).toHaveBeenCalledTimes(1);
  });

  it('honours a $0 threshold instead of reading it as "unset"', async () => {
    // A falsy-check here silently disabled auto-top-up for anyone who chose
    // "reload when I hit zero", while the settings page still said it was on.
    await seedSettings({ balance: 0, thresholdMicros: 0 });

    paymentIntentCreate.mockResolvedValue({
      id: 'pi_1',
      status: 'succeeded',
      latest_charge: null,
    });

    const billing = createBillingMethods(db, teamId, userId);
    await billing.checkAutoTopUp();

    expect(paymentIntentCreate).toHaveBeenCalledTimes(1);
    expect(await balanceOf()).toBe(100_000_000);
  });

  it('does not credit when the payment intent does not succeed', async () => {
    await seedSettings({ balance: 3_000_000, thresholdMicros: 5_000_000 });

    paymentIntentCreate.mockResolvedValue({
      id: 'pi_1',
      status: 'requires_action',
      latest_charge: null,
    });

    const billing = createBillingMethods(db, teamId, userId);
    await billing.checkAutoTopUp();

    expect(paymentIntentCreate).toHaveBeenCalledTimes(1);
    expect(await balanceOf()).toBe(3_000_000);
  });
});

describe('updateAutoTopUpSettings validation', () => {
  it('rejects an amount that would not lift the balance past the threshold', async () => {
    await db.insert(credits).values({ teamId, balance: 0 });
    const billing = createBillingMethods(db, teamId, userId);

    await expect(
      billing.updateAutoTopUpSettings({
        enabled: true,
        thresholdMicros: micros(20_000_000), // $20
        amountMicros: micros(10_000_000), // $10 — reload stays under it
      })
    ).rejects.toThrow(/greater than the threshold/);
  });
});
