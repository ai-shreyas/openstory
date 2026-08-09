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
 * Run `fn` over `items` in waves of `concurrency`.
 * Within a wave: `Promise.allSettled` (one failure does not reject the wave).
 * Between waves: sequential.
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
