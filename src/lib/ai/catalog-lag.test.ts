/**
 * Guards for CATALOG_LAG_MODELS (create-adapter.ts) — the registry model ids
 * that @tanstack/ai-openrouter's generated catalog doesn't know yet.
 *
 * The prune check is compile-time: when a package bump ships a lag id in the
 * upstream catalog, `bun typecheck` fails here naming the id — delete its
 * entry from CATALOG_LAG_MODELS in the same PR. The model-freshness routine
 * (#792) runs these gates on every @tanstack/ai* bump, so the cleanup lands
 * in the bump PR automatically.
 */
import type { OpenRouterModelOptionsByName } from '@tanstack/ai-openrouter';
import { describe, expectTypeOf, it } from 'vitest';
import type { CATALOG_LAG_MODELS } from './create-adapter';
import type { AnalysisModelId } from './models.config';

type CatalogId = keyof OpenRouterModelOptionsByName;
type LagId = (typeof CATALOG_LAG_MODELS)[number]['name'];

/** Lag ids the upstream catalog now includes — must stay `never`. */
type StaleLagEntries = Extract<CatalogId, LagId>;

/** Lag ids that left the model registry — must stay `never`. */
type UnregisteredLagEntries = Exclude<LagId, AnalysisModelId>;

describe('CATALOG_LAG_MODELS', () => {
  it('contains no id the upstream catalog now ships (prune it when this fails)', () => {
    expectTypeOf<StaleLagEntries>().toBeNever();
  });

  it('only bridges ids that are still in the model registry', () => {
    expectTypeOf<UnregisteredLagEntries>().toBeNever();
  });
});
