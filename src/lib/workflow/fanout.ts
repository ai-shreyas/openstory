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

/** Starting concurrency caps for parent fan-out phases. Tune via call sites. */
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
 * In-flight ceilings for the image fan-out, resolved together so an override
 * can't half-apply. `Infinity` is legal — the window degenerates to "start
 * everything", which is the pre-#1126 shape.
 */
export type ImageFanoutShape = {
  /** Concurrent (scene × model) image children. */
  images: number;
  /** Concurrent fire-and-forget `/variant-image` creates. */
  variantTrigger: number;
};

const DEFAULT_FANOUT: ImageFanoutShape = {
  images: FANOUT_CONCURRENCY.image,
  variantTrigger: FANOUT_CONCURRENCY.variantTrigger,
};

const UNBOUNDED_FANOUT: ImageFanoutShape = {
  images: Number.POSITIVE_INFINITY,
  variantTrigger: Number.POSITIVE_INFINITY,
};

/**
 * Runtime override for the image fan-out ceiling, kept from the #1143 A/B so
 * the decision stays re-testable without a redeploy:
 *
 *   unset / ''  → the tuned default
 *   '0'         → unbounded (pre-#1126 shape)
 *   'N'         → N concurrent image children
 *
 * A malformed value falls back to the default rather than silently unbounding
 * the fan-out — the failure mode of a typo here is a stampede.
 */
export function resolveImageFanout(env: {
  FANOUT_IMAGE_CONCURRENCY?: string;
}): ImageFanoutShape {
  const raw = env.FANOUT_IMAGE_CONCURRENCY?.trim();
  // Strict digits-only: `parseInt` would read "12abc" as 12 and "4.9" as 4,
  // so a typo would quietly pick a ceiling nobody chose.
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_FANOUT;

  const parsed = Number.parseInt(raw, 10);
  return parsed === 0
    ? UNBOUNDED_FANOUT
    : { ...DEFAULT_FANOUT, images: parsed };
}

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
