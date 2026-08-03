/**
 * "Top up to" auto-top-up semantics (#1099): the off-session charge brings
 * the balance up to the configured target (OpenAI-style auto-reload), rather
 * than adding a flat amount.
 */

import { micros } from '@/lib/billing/money';
import type { Database } from '@/lib/db/client';
import { generateId } from '@/lib/db/id';
import {
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

describe('maybeAutoTopUp ("top up to" semantics)', () => {
  it('charges target − balance and restores the balance to the target', async () => {
    await db.insert(credits).values({ teamId, balance: 3_000_000 }); // $3
    await db.insert(teamBillingSettings).values({
      teamId,
      stripeCustomerId: 'cus_1',
      autoTopUpEnabled: true,
      autoTopUpThresholdMicros: 5_000_000, // $5
      autoTopUpAmountMicros: 100_000_000, // top up to $100
    });

    paymentIntentCreate.mockResolvedValue({
      id: 'pi_1',
      status: 'succeeded',
      latest_charge: { receipt_url: 'https://receipt' },
    });

    const billing = createBillingMethods(db, teamId, userId);
    await billing.checkAutoTopUp();

    // $97 credited + 7% fee → $103.79 charged
    expect(paymentIntentCreate).toHaveBeenCalledTimes(1);
    expect(paymentIntentCreate.mock.calls[0]?.[0]).toMatchObject({
      amount: 10_379,
      customer: 'cus_1',
      payment_method: 'pm_1',
      off_session: true,
    });

    const [row] = await db
      .select({ balance: credits.balance })
      .from(credits)
      .where(eq(credits.teamId, teamId));
    expect(row?.balance).toBe(100_000_000);
  });

  it('does not charge when the balance is above the threshold', async () => {
    await db.insert(credits).values({ teamId, balance: 50_000_000 }); // $50
    await db.insert(teamBillingSettings).values({
      teamId,
      stripeCustomerId: 'cus_1',
      autoTopUpEnabled: true,
      autoTopUpThresholdMicros: 5_000_000,
      autoTopUpAmountMicros: 100_000_000,
    });

    const billing = createBillingMethods(db, teamId, userId);
    await billing.checkAutoTopUp();

    expect(paymentIntentCreate).not.toHaveBeenCalled();
  });
});

describe('updateAutoTopUpSettings validation', () => {
  it('rejects a target less than the minimum gap above the threshold', async () => {
    await db.insert(credits).values({ teamId, balance: 0 });
    const billing = createBillingMethods(db, teamId, userId);

    await expect(
      billing.updateAutoTopUpSettings({
        enabled: true,
        thresholdMicros: micros(8_000_000), // $8
        amountMicros: micros(10_000_000), // $10 — only $2 above
      })
    ).rejects.toThrow(/above the threshold/);
  });
});
