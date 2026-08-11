/**
 * Bounded fan-out for Cloudflare Workflow parents.
 *
 * Parents used to `Promise.allSettled` over every child spawn at once, which
 * stampsed Workflow isolates + D1 under large batches (hung-cancel storms).
 * Waves keep at most `concurrency` jobs in flight: each wave is an
 * allSettled, waves run sequentially.
 *
 * Replay-safe when each `fn` still uses stable `step.do` / waitForEvent
 * names (e.g. `spawn-image-${index}`) — completed steps return cached
 * results on parent re-entry.
 */

/** Starting concurrency caps for parent fan-out phases. Tune via call sites. */
export const FANOUT_CONCURRENCY = {
  /** Image children (`spawnAndAwaitChild` to IMAGE_WORKFLOW). */
  image: 4,
  /** Fire-and-forget `/variant-image` creates. */
  variantTrigger: 8,
  /** Character / location sheet children. */
  sheet: 4,
  /** Motion children in motion-batch. */
  motion: 3,
} as const;

/**
 * `FANOUT_IMAGE_CONCURRENCY` is a runtime-only binding set with
 * `wrangler secret put`, deliberately absent from wrangler.jsonc so it doesn't
 * claim the binding name (Cloudflare rejects a secret that collides with a
 * config var). `wrangler types` therefore can't know about it, so declare it
 * here rather than hand-editing the generated worker-configuration.d.ts — the
 * pre-commit typegen hook rewrites that file and would silently drop the edit.
 */
declare global {
  namespace Cloudflare {
    interface Env {
      FANOUT_IMAGE_CONCURRENCY?: string;
    }
  }
}

/**
 * The three fan-out widths #1126 bounded, resolved together so an arm of the
 * A/B can't half-apply. `Infinity` is a legal wave width — `mapInWaves`
 * degenerates to a single `allSettled` over every item, which is exactly the
 * pre-#1126 shape.
 */
export type ImageFanoutShape = {
  /** Outer fan-out: scenes (shot-images) / shots (regenerate-shots). */
  scenes: number;
  /** Inner fan-out: image models per scene. */
  models: number;
  /** Fire-and-forget `/variant-image` creates per wave. */
  variantTrigger: number;
};

const PRODUCTION_FANOUT: ImageFanoutShape = {
  scenes: FANOUT_CONCURRENCY.image,
  models: 1,
  variantTrigger: FANOUT_CONCURRENCY.variantTrigger,
};

const UNBOUNDED_FANOUT: ImageFanoutShape = {
  scenes: Number.POSITIVE_INFINITY,
  models: Number.POSITIVE_INFINITY,
  variantTrigger: Number.POSITIVE_INFINITY,
};

/**
 * Load-test knob for the #1126 A/B. `FANOUT_IMAGE_CONCURRENCY` lets both arms
 * run from one build, so the comparison isn't confounded by a second deploy:
 *
 *   unset / ''  → production waves (scenes 4, one model at a time)
 *   '0'         → pre-#1126 shape: every fan-out unbounded
 *   'N'         → scenes N, one model at a time
 *
 * A malformed value falls back to production rather than silently unbounding
 * the fan-out — the failure mode of a typo here is a stampede.
 */
export function resolveImageFanout(env: {
  FANOUT_IMAGE_CONCURRENCY?: string;
}): ImageFanoutShape {
  const raw = env.FANOUT_IMAGE_CONCURRENCY?.trim();
  // Strict digits-only: `parseInt` would read "12abc" as 12 and "4.9" as 4,
  // so a typo would quietly pick a width nobody chose.
  if (!raw || !/^\d+$/.test(raw)) return PRODUCTION_FANOUT;

  const parsed = Number.parseInt(raw, 10);
  return parsed === 0
    ? UNBOUNDED_FANOUT
    : { ...PRODUCTION_FANOUT, scenes: parsed };
}

/**
 * Run `fn` over `items` in waves of `concurrency`.
 * Within a wave: `Promise.allSettled` (one failure does not reject the wave).
 * Between waves: sequential.
 *
 * `Infinity` is a legal width: the first slice takes every item and the
 * `i += limit` step exits the loop, so the whole set runs as one `allSettled`.
 */
export async function mapInWaves<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  if (items.length === 0) return [];

  const limit = Math.max(1, Math.floor(concurrency));
  const out: PromiseSettledResult<R>[] = [];

  for (let i = 0; i < items.length; i += limit) {
    const slice = items.slice(i, i + limit);
    const base = i;
    const wave = await Promise.allSettled(
      slice.map((item, j) => fn(item, base + j))
    );
    out.push(...wave);
  }

  return out;
}
