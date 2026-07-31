import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'ai', 'fal-cost']);
/**
 * Fal.ai cost calculation.
 *
 * Billing is exact: fal reports the quantity it billed for a generation as
 * `unitsBilled` (via the `x-fal-billable-units` header, surfaced by the TanStack
 * AI adapter), denominated in the endpoint's priced unit. The cost is simply
 * `unitsBilled * unitPrice` — fal already accounts for resolution, audio,
 * duration, etc. in the unit count, so no per-model multipliers are needed.
 *
 * `estimateFalCost` predicts a cost BEFORE a generation runs (no `unitsBilled`
 * yet) for the pre-flight credit gate. For image/flat/compute-seconds models
 * it needs a units-per-call count, preferred in this order (#1069):
 *
 * 1. `observed.medianUnits` — median `unitsBilled` across our own recent
 *    generations, from the `model_pricing` D1 table (refreshed daily by the
 *    Worker cron; see `getEffectiveFalPricing`). Used only once
 *    `MIN_OBSERVED_SAMPLES` generations back it.
 * 2. `typicalUnitsPerCall` — fal's historical estimate (baked into
 *    fal-pricing-data.ts by `bun scripts/update-fal-pricing.ts`, refreshed
 *    live by the same cron).
 * 3. With neither signal: **null** ("unknown"), logged. No fabricated
 *    default — a fixed one made Grok Imagine read ~98× cheap, which is what
 *    #1069 was. Callers gate conservatively / display nothing instead.
 *
 * That applies to compute_seconds, images and flat alike: an `images` price
 * is not reliably per-image (fal denominates gpt-image-2 and phota in
 * fractional "units", so a real call bills ~0.22), and a flat rate can cover
 * an arbitrary unit count. Guessing 1 is the same class of error as guessing
 * 3 seconds — it just happens to be wrong by less on the models we seed.
 *
 * Megapixel and duration-based models (seconds / minutes / tokens) stay
 * parametric from request params and never need a unit-count signal.
 */

import type { FalPricing } from '@/lib/ai/fal-pricing-data';
// Type-only: erased at compile, so this adds no runtime edge to the DB schema
// module and this file stays importable by pure, DB-free callers.
import type { ObservedUnits } from '@/lib/db/schema/model-pricing';
import {
  type Microdollars,
  ZERO_MICROS,
  multiplyMicros,
} from '@/lib/billing/money';

/** `FalPricing` plus the observed-units signal from the `model_pricing` table. */
export type EffectiveFalPricing = FalPricing & {
  /**
   * Our own recent generations. Median and sample count travel together (one
   * shared {@link ObservedUnits}) so a median can never be read without the
   * confidence behind it — an n=1 median is an anecdote, not a statistic.
   *
   * Present whenever the table has a median at all, at ANY sample count —
   * `MIN_OBSERVED_SAMPLES` is applied by readers, not at construction, so a
   * future caller that wants to show "based on N samples" still can. Anything
   * deciding money must go through `knownUnitsPerCall`.
   *
   * `medianUnits` is per **image** (per call for non-image endpoints): the
   * refresh cron divides each sample's `unitsBilled` by that call's
   * `numImages`, matching how the estimator multiplies it back up below.
   */
  observed?: ObservedUnits;
};

/**
 * Observations needed before our own median outranks fal's historical
 * estimate. Below this we prefer fal's figure, or report unknown and let the
 * caller gate on the conservative floor — a single unrepresentative sample
 * (an aborted-but-billed generation) would otherwise under-gate by orders of
 * magnitude, which is #1069 wearing a better hat.
 */
export const MIN_OBSERVED_SAMPLES = 5;

/** Assumed 16:9 output dimensions per resolution tier for token-priced models */
const TOKEN_RESOLUTION_DIMENSIONS: Record<
  string,
  { width: number; height: number }
> = {
  '480p': { width: 854, height: 480 },
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
};

// ============================================================================
// Actual cost (billing) — unitsBilled * unitPrice
// ============================================================================

/**
 * Exact fal cost for a completed generation: `unitsBilled * unitPrice`.
 *
 * Prices from the live `model_pricing` table, falling back to the baked-in
 * seed for endpoints with no row yet. The cron detects fal price moves daily,
 * so charging from the seed alone under-billed every increase until someone
 * remembered to re-run `bun scripts/update-fal-pricing.ts`.
 *
 * Returns `ZERO_MICROS` and logs an error when pricing is missing or fal did
 * not report `unitsBilled` — we charge nothing rather than guess, so a usage
 * regression surfaces loudly instead of silently mis-billing.
 *
 * Every caller runs this AFTER fal has generated and billed, inside a retried
 * workflow step, so it must never throw: a rejected promise there discards a
 * finished image and pays fal a second time on the retry. A failed pricing
 * read therefore takes the same deliberate under-charge as missing pricing.
 */
export async function falCostFromUnits(
  endpointId: string,
  unitsBilled: number | undefined,
  pricingMap?: Record<string, EffectiveFalPricing>
): Promise<Microdollars> {
  // Resolved lazily so pure callers (and tests) can pass a map and skip D1,
  // mirroring `estimateFalCost`'s optional-map shape. The dynamic import keeps
  // `#db-client` out of the module graph for callers that only ever estimate.
  let resolved: Record<string, EffectiveFalPricing>;
  if (pricingMap) {
    resolved = pricingMap;
  } else {
    try {
      const { getEffectiveFalPricing } =
        await import('@/lib/ai/fal-pricing-live');
      resolved = await getEffectiveFalPricing();
    } catch (err) {
      logger.error(
        `Failed to read live pricing for ${endpointId} — charging nothing rather than failing a completed generation`,
        { err, endpointId, unitsBilled }
      );
      return ZERO_MICROS;
    }
  }
  const pricing = resolved[endpointId];
  if (!pricing) {
    logger.error(`No fal pricing data for endpoint: ${endpointId}`);
    return ZERO_MICROS;
  }
  if (unitsBilled == null || !Number.isFinite(unitsBilled)) {
    logger.error(
      `No unitsBilled reported for ${endpointId} — charging nothing`,
      { unitsBilled }
    );
    return ZERO_MICROS;
  }
  return multiplyMicros(pricing.unitPrice, unitsBilled);
}

// ============================================================================
// Pre-flight estimation — predicts a unit count from generation params
// ============================================================================

export type FalCostEstimateParams = {
  numImages?: number;
  durationSeconds?: number;
  widthPx?: number;
  heightPx?: number;
  fps?: number;
  resolution?: string;
};

const isUsableCount = (n: number | undefined | null): n is number =>
  n != null && Number.isFinite(n) && n > 0;

/**
 * Predicted unitsBilled for one generation call: our observed median first
 * (once it has `MIN_OBSERVED_SAMPLES` behind it), then fal's historical
 * estimate. Undefined when neither signal qualifies.
 */
function knownUnitsPerCall(pricing: EffectiveFalPricing): number | undefined {
  const { observed } = pricing;
  if (
    observed &&
    observed.sampleCount >= MIN_OBSERVED_SAMPLES &&
    isUsableCount(observed.medianUnits)
  ) {
    return observed.medianUnits;
  }
  return isUsableCount(pricing.typicalUnitsPerCall)
    ? pricing.typicalUnitsPerCall
    : undefined;
}

/**
 * Rough pre-flight cost estimate, used only for the credit-availability gate
 * before a generation runs. Predicts the billed unit count, then multiplies
 * by `unitPrice`. The exact charge comes from `falCostFromUnits` once fal
 * reports `unitsBilled`.
 *
 * Returns **null when no honest estimate exists** — the endpoint has no
 * pricing data, or a compute_seconds model has no unit-count signal. Callers
 * gate conservatively / display nothing; never fabricate a number (#1069).
 *
 * Image / flat models: use observed/historical units per call (not unitPrice
 * alone — openai/gpt-image-2 has unit_price=$1 with ~0.22 units per
 * high-quality image, so assuming 1 unit would over-gate ~5×).
 *
 * Duration models (seconds / minutes / tokens): parametric from request
 * params — historical averages encode a random past duration and would be
 * wrong for the requested length.
 *
 * `pricingMap` is required, and required on every wrapper in
 * `cost-estimation.ts` too. It used to default to the baked-in seed, which
 * meant a call site that forgot it silently estimated on frozen prices — the
 * #1069 failure mode reached by a different route, and invisible because the
 * number still looked plausible. Pass `getEffectiveFalPricing()` on server
 * paths; pass `FAL_PRICING` explicitly to assert against the seed.
 */
export function estimateFalCost(
  endpointId: string,
  params: FalCostEstimateParams,
  pricingMap: Record<string, EffectiveFalPricing>
): Microdollars | null {
  const pricing = pricingMap[endpointId];
  if (!pricing) {
    logger.error(`No fal pricing data for endpoint: ${endpointId}`);
    return null;
  }

  const numImages = params.numImages ?? 1;
  const duration = params.durationSeconds ?? 0;

  switch (pricing.unit) {
    // Per-call unit counts. Observed/historical units capture quality and
    // resolution premiums (nano-banana bills ~1.5 units, gpt-image-2 ~0.22),
    // and fal's "units" denominator means neither price is reliably per-call —
    // so with no signal these report unknown rather than assuming 1. Every
    // seeded endpoint carries a historical figure today; the null path is for
    // a model the cron has just discovered.
    case 'images':
    case 'flat': {
      const unitsPerCall = knownUnitsPerCall(pricing);
      if (unitsPerCall == null) {
        logger.error(
          `No unit-count signal for ${pricing.unit} endpoint ${endpointId} — ` +
            'estimate unknown (returns once a generation records unitsBilled)'
        );
        return null;
      }
      // Flat-rate video bills one unit set per generation, not per image.
      const calls = pricing.unit === 'images' ? numImages : 1;
      return multiplyMicros(pricing.unitPrice, unitsPerCall * calls);
    }

    case 'megapixels': {
      const w = params.widthPx ?? 1024;
      const h = params.heightPx ?? 1024;
      const megapixels = (w * h) / 1_000_000;
      return multiplyMicros(pricing.unitPrice, megapixels * numImages);
    }

    case 'compute_seconds': {
      // Compute time is unknowable from request params — models span ~10 to
      // ~294 seconds per image (FLUX.2 vs Grok Imagine), so a fixed default
      // is off by orders of magnitude in one direction or the other. With no
      // observed or historical count, say so.
      const secondsPerImage = knownUnitsPerCall(pricing);
      if (secondsPerImage == null) {
        logger.error(
          `No unit-count signal for compute_seconds endpoint ${endpointId} — ` +
            'estimate unknown (returns once a generation records unitsBilled)'
        );
        return null;
      }
      return multiplyMicros(pricing.unitPrice, secondsPerImage * numImages);
    }

    case 'seconds':
      return multiplyMicros(pricing.unitPrice, duration);

    case 'minutes':
      return multiplyMicros(pricing.unitPrice, Math.ceil(duration / 60));

    case 'tokens': {
      const dims = params.resolution
        ? TOKEN_RESOLUTION_DIMENSIONS[params.resolution]
        : undefined;
      const w = params.widthPx ?? dims?.width ?? 1920;
      const h = params.heightPx ?? dims?.height ?? 1080;
      const fps = params.fps ?? 24;
      // fal derives tokens from pixels (≈ w·h·fps·sec / 1024) and prices per
      // 1000-token unit; ~5% overhead on nominal shots.
      const units = ((w * h * fps * duration) / 1024 / 1000) * 1.05;
      return multiplyMicros(pricing.unitPrice, units);
    }

    default: {
      // Exhaustiveness guard: a new FalUnit without a case fails to compile.
      const _exhaustive: never = pricing.unit;
      // `unit` is a `$type<>()` assertion over a plain D1 text column, so an
      // unrecognised value reaches here at runtime despite the compile-time
      // check. Returning `_exhaustive` would hand that raw string back as
      // `Microdollars` and float it into the credit gate — report unknown.
      logger.error(
        `Unrecognised fal unit for ${endpointId} — estimate unknown`,
        { unit: String(_exhaustive) }
      );
      return null;
    }
  }
}
