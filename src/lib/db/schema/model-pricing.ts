/**
 * Model Pricing (#1069).
 *
 * Live per-provider pricing store, refreshed by the Worker cron
 * (`src/lib/cron/refresh-fal-pricing.ts` — fal today; an OpenRouter fetcher
 * can add `provider: 'openrouter'` rows later with no migration).
 * Platform-global (not team-scoped), pure derived cache — every row is
 * rebuildable from the provider APIs + our own transactions.
 *
 * `model_pricing` is the current snapshot. The key is
 * (provider, endpointId, unit): one row per fal endpoint, and room for
 * multi-rate models later (an LLM's input/output token rates are two rows).
 * Each row carries the provider's per-unit price plus two unit-count signals
 * for pre-flight estimation — `observedMedianUnits` (median `unitsBilled`
 * from our own generations, the preferred signal) and `typicalUnitsPerCall`
 * (fal's historical estimate, the fallback). Estimation merges these rows
 * over the baked-in `FAL_PRICING` seed. Billing reads the same merged prices
 * (`falCostFromUnits`), multiplying them by the provider-reported
 * `unitsBilled` — so a provider price move reaches charges without waiting on
 * a seed regeneration.
 *
 * `model_pricing_history` appends a row whenever a model's unit price
 * changes (and on first sight), giving a time-series of model costs.
 */

import {
  index,
  integer,
  primaryKey,
  real,
  snakeCase,
  text,
} from 'drizzle-orm/sqlite-core';
import type { FalUnit } from '@/lib/ai/fal-pricing-data';
import { generateId } from '../id';

export type ModelPricingProvider = 'fal' | 'openrouter';

/**
 * Billed unit denominators across providers — fal's kinds today; LLM token
 * rate kinds (e.g. 'input_tokens' / 'output_tokens') widen this union when
 * the OpenRouter fetcher lands.
 */
export type ModelPricingUnit = FalUnit;

export const modelPricing = snakeCase.table(
  'model_pricing',
  {
    provider: text({ length: 50 }).$type<ModelPricingProvider>().notNull(),
    endpointId: text({ length: 200 }).notNull(),
    unit: text({ length: 30 }).$type<ModelPricingUnit>().notNull(),
    /** Per-unit price in microdollars, verbatim from the provider's API. */
    unitPriceMicros: integer().notNull(),
    /** Provider's historical estimate of units per call (null = no history). */
    typicalUnitsPerCall: real(),
    /** Median unitsBilled across our own recent generations (null = none yet). */
    observedMedianUnits: real(),
    /** How many of our generations back the observed median. */
    observedSampleCount: integer().default(0).notNull(),
    /** When the provider's pricing API was last fetched successfully. */
    fetchedAt: integer({ mode: 'timestamp' }).notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.endpointId, table.unit] }),
  ]
);

/**
 * Raw per-generation usage samples — the input the observed median is computed
 * from. Written for **every** fal generation, including BYOK, zero-cost and
 * insufficient-credit ones: those write no transaction row, so mining the
 * ledger only ever learned from teams in good standing without their own key.
 *
 * Deliberately carries no `teamId`: it is anonymous model-behaviour telemetry,
 * not team data, so it needs no FK (and cannot participate in the D1
 * table-rebuild cascade trap). Pruned to the observation window by the cron.
 */
export const modelUsageObservations = snakeCase.table(
  'model_usage_observations',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    provider: text({ length: 50 }).$type<ModelPricingProvider>().notNull(),
    endpointId: text({ length: 200 }).notNull(),
    /** Units the provider billed for this one call. */
    unitsBilled: real().notNull(),
    /** Assets this one call rendered; the median divides by it (#1069). */
    numImages: integer().default(1).notNull(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_model_usage_obs_endpoint_created').on(
      table.provider,
      table.endpointId,
      table.createdAt
    ),
  ]
);

export const modelPricingHistory = snakeCase.table(
  'model_pricing_history',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    provider: text({ length: 50 }).$type<ModelPricingProvider>().notNull(),
    endpointId: text({ length: 200 }).notNull(),
    unit: text({ length: 30 }).$type<ModelPricingUnit>().notNull(),
    unitPriceMicros: integer().notNull(),
    recordedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_model_pricing_history_endpoint').on(
      table.provider,
      table.endpointId,
      table.recordedAt
    ),
  ]
);
