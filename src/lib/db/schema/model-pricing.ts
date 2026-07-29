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
 * over the baked-in `FAL_PRICING` seed; billing never reads this table (it
 * multiplies the provider-reported `unitsBilled` / actual cost at generation
 * time).
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
