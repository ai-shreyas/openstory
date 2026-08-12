/**
 * Bounded fan-out for Cloudflare Workflow parents.
 *
 * Parents used to `Promise.allSettled` over every child spawn at once, which
 * stampeded Workflow isolates + D1 under large batches. #1126 bounded that
 * with waves — slices of N run to completion before the next slice starts.
 *
 * The #1143 load test measured what that cost and bought (20 concurrent
 * sequences per arm, same build, knob-flipped): hangs 1 vs 2 — indistinguishable
 * — but p95 wall clock 2055s bounded vs 1400s unbounded. A wave is a barrier,
 * so every slice waits for its slowest child and tail latency compounds ×
 * ceil(N/limit). A rolling window holds the same in-flight ceiling without the
 * barrier: as each job finishes the next starts immediately.
 *
 * Replay-safe when each `fn` uses stable `step.do` / `waitForEvent` names
 * (e.g. `spawn-image-${sceneId}-${model}`) — completed steps return cached
 * results on parent re-entry, and the window only affects the order work is
 * *started* in, never its identity.
 */

/** Concurrency caps for parent fan-out phases. Tune via call sites. */
export const FANOUT_CONCURRENCY = {
  /**
   * Image children (`spawnAndAwaitChild` to IMAGE_WORKFLOW), counted over
   * flattened (scene × model) pairs — NOT per scene. #1126 capped scenes at 4
   * and then ran models one at a time inside each scene, so a 2-model batch
   * serialised into 2× the waves. Flattened, one number is the real ceiling.
   */
  image: 8,
  /** Fire-and-forget `/variant-image` creates. */
  variantTrigger: 8,
  /** Character / location sheet children. */
  sheet: 4,
  /** Motion children in motion-batch. */
  motion: 3,
} as const;

/**
 * Run `fn` over `items` with at most `concurrency` in flight at any moment,
 * starting the next item the instant one finishes.
 *
 * Results are returned in INPUT order regardless of completion order, and a
 * rejection is captured per item (never thrown) so one failure can't poison
 * its peers — same isolation `Promise.allSettled` gives, without the barrier.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  if (items.length === 0) return [];

  const limit = Math.max(1, Math.min(Math.floor(concurrency), items.length));
  const out: PromiseSettledResult<R>[] = [];
  out.length = items.length;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) {
        // Only reachable via a sparse array; surface it rather than silently
        // dropping the slot, which would shift every downstream index.
        out[index] = {
          status: 'rejected',
          reason: new Error(`fan-out item at index ${index} was undefined`),
        };
        continue;
      }
      try {
        out[index] = { status: 'fulfilled', value: await fn(item, index) };
      } catch (reason) {
        out[index] = { status: 'rejected', reason };
      }
    }
  };

  await Promise.all(Array.from({ length: limit }, worker));
  return out;
}
