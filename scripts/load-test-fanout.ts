/**
 * Load driver for the #1126 fan-out A/B.
 *
 * Fires N identical sequences at a deployment **concurrently** and reports
 * wall-clock plus the exact UTC window to query Workers Observability for
 * `…had hung and would never generate a response`. The burst shape matters:
 * the original 275 hangs (Aug 5–7) tracked traffic spikes, not steady load,
 * so sequences are created all at once rather than paced.
 *
 * Arms are selected by the `FANOUT_IMAGE_CONCURRENCY` var on the *deployment*
 * (see resolveImageFanout in src/lib/workflow/map-in-waves.ts), NOT by this
 * script — it only generates load and timestamps it:
 *
 *   arm A (production shape) → var unset
 *   arm B (pre-#1126 shape)  → var "0"
 *
 * Cost control: `motion: false` + `music: false` (images only) on the
 * cheapest image model. Never point this at production without meaning to —
 * it creates real sequences and spends real fal credit.
 *
 *   OPENSTORY_API_KEY=osk_… bun scripts/load-test-fanout.ts \
 *     --base-url https://openstory-pr-1234.workers.dev --arm B --sequences 20 --confirm
 */

import { z } from 'zod';
import { createSampleSequence } from './sample-pipeline';

/**
 * Sequence state as the API returns it TODAY: `shots` / `counts.shots`.
 *
 * We deliberately don't reuse `waitForSampleSequence` from ./sample-pipeline —
 * its schema still expects the pre-#1067 `frames` / `counts.frames` shape and
 * throws on every poll against the current API. That staleness is a real bug
 * in the style-sample renderer, but fixing a shared script is out of scope for
 * a fan-out load test, so this driver polls with its own narrow schema.
 */
const sequenceStateSchema = z.object({
  id: z.string(),
  status: z.string(),
  statusError: z.string().nullish(),
  counts: z.object({
    shots: z.number(),
    imagesReady: z.number(),
  }),
});

type SequenceState = z.infer<typeof sequenceStateSchema>;

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'archived']);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Long-poll one sequence to a terminal state. `?wait=Ns` blocks server-side
 * (capped at 90s), so this is cheap to hold open across many sequences. A 429
 * is the per-key 10 req/s limit — every poller fires its first GET at once —
 * so honour Retry-After rather than hammering.
 */
async function pollToTerminal(
  config: { baseUrl: string; apiKey: string },
  id: string,
  timeoutMs: number
): Promise<SequenceState> {
  const deadline = Date.now() + timeoutMs;
  let last: SequenceState | undefined;

  while (Date.now() < deadline) {
    const res = await fetch(
      `${config.baseUrl}/api/v1/sequences/${id}?wait=60s`,
      { headers: { 'x-api-key': config.apiKey } }
    );

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(
        (Number.isFinite(retryAfter) ? retryAfter * 1000 : 2000) +
          Math.random() * 250
      );
      continue;
    }
    if (!res.ok) {
      throw new Error(
        `Poll failed (${res.status}): ${(await res.text()).slice(0, 300)}`
      );
    }

    last = sequenceStateSchema.parse(await res.json());
    if (TERMINAL_STATUSES.has(last.status)) return last;
    await sleep(1000);
  }

  throw new Error(
    `Timed out after ${Math.round(timeoutMs / 1000)}s (last status: ${last?.status ?? 'unknown'})`
  );
}

/** Cheapest image model in the catalog: $0.008/megapixel (~$0.008 at 1MP). */
const DEFAULT_IMAGE_MODEL = 'flux_2_turbo';
const DEFAULT_STYLE = 'Product Ad';
const DEFAULT_SEQUENCES = 20;
const DEFAULT_TARGET_SECONDS = 30;

/** Rough per-image price for the estimate only — fal's bill is the truth. */
const TURBO_USD_PER_IMAGE = 0.008;

/**
 * Fixed script, `enhance: 'off'` — the pipeline scene-splits it verbatim, so
 * every sequence in every arm produces the same scene count. Two recurring
 * characters and two locations so the character/location bible + sheet
 * workflows fire; those LLM workflows carried two-thirds of the original
 * hang triggers and would be missed by an images-only-looking test.
 */
const SCRIPT = `A courier named Mira steps off a night bus onto a rain-slick street.
She checks a paper address under a flickering awning.
Inside a narrow lock-up garage, a mechanic named Ovie is closing for the night.
Mira hands him a sealed package. He does not take it.
Ovie wipes his hands and finally sets the package on the bench.
He cuts the seal. Light spills from inside the box.
Mira steps back toward the garage door, watching him.
Ovie looks up at her for the first time.
Outside, the rain stops. The street is silent.
Mira walks back toward the bus stop alone.`;

type Args = {
  baseUrl: string;
  arm: string;
  sequences: number;
  imageModel: string;
  style: string;
  targetSeconds: number;
  confirm: boolean;
};

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const baseUrl = get('--base-url');
  if (!baseUrl) throw new Error('--base-url is required');

  const sequences = Number(get('--sequences') ?? DEFAULT_SEQUENCES);
  if (!Number.isInteger(sequences) || sequences < 1) {
    throw new Error('--sequences must be a positive integer');
  }

  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    arm: get('--arm') ?? 'unlabelled',
    sequences,
    imageModel: get('--image-model') ?? DEFAULT_IMAGE_MODEL,
    style: get('--style') ?? DEFAULT_STYLE,
    targetSeconds: Number(get('--target-seconds') ?? DEFAULT_TARGET_SECONDS),
    confirm: argv.includes('--confirm'),
  };
}

type Outcome = {
  index: number;
  id?: string;
  ok: boolean;
  ms: number;
  shots: number;
  imagesReady: number;
  error?: string;
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i] ?? 0;
}

async function runOne(
  config: { baseUrl: string; apiKey: string },
  args: Args,
  index: number
): Promise<Outcome> {
  const started = Date.now();
  // Declared outside the try so a post-create failure still reports which
  // sequence it was — otherwise every poll error reads as "never created".
  let createdId: string | undefined;
  try {
    const created = await createSampleSequence(config, {
      script: SCRIPT,
      title: `loadtest-${args.arm}-${index}`,
      enhance: 'off',
      targetSeconds: args.targetSeconds,
      styleName: args.style,
      aspectRatio: '16:9',
      imageModel: args.imageModel,
      // Unused when motion is off, but the API requires a video model key.
      videoModel: 'seedance_v2',
      motion: false,
    });
    createdId = created.id;

    const state = await pollToTerminal(config, createdId, 45 * 60 * 1000);

    return {
      index,
      id: createdId,
      ok: state.status === 'completed',
      ms: Date.now() - started,
      shots: state.counts.shots,
      imagesReady: state.counts.imagesReady,
      error: state.statusError ?? undefined,
    };
  } catch (error) {
    return {
      index,
      id: createdId,
      ok: false,
      ms: Date.now() - started,
      shots: 0,
      imagesReady: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.OPENSTORY_API_KEY;
  if (!apiKey) throw new Error('OPENSTORY_API_KEY is required');

  // Guard against pointing a spend-real-money burst at prod by muscle memory.
  const looksProd = /openstory\.so|openstory\.com/.test(args.baseUrl);

  console.log(`arm            ${args.arm}`);
  console.log(
    `base url       ${args.baseUrl}${looksProd ? '  ⚠️  LOOKS LIKE PRODUCTION' : ''}`
  );
  console.log(`sequences      ${args.sequences} (fired concurrently)`);
  console.log(`image model    ${args.imageModel}`);
  console.log(`style          ${args.style}`);
  console.log(`motion/music   off`);
  // ~10 scenes → 10 stills + 10 variant grids + ~4 sheets.
  const estImages = args.sequences * 24;
  console.log(
    `est. cost      ~$${(estImages * TURBO_USD_PER_IMAGE).toFixed(2)} (~${estImages} images @ $${TURBO_USD_PER_IMAGE})`
  );

  if (!args.confirm) {
    console.log('\nDry run — re-run with --confirm to actually spend.');
    return;
  }

  const config = { baseUrl: args.baseUrl, apiKey };
  const windowStart = new Date().toISOString();
  console.log(`\nwindow start   ${windowStart}`);

  const outcomes = await Promise.all(
    Array.from({ length: args.sequences }, (_, i) => runOne(config, args, i))
  );

  const windowEnd = new Date().toISOString();
  const durations = outcomes.map((o) => o.ms).sort((a, b) => a - b);
  const ok = outcomes.filter((o) => o.ok);
  const totalImages = outcomes.reduce((sum, o) => sum + o.imagesReady, 0);

  console.log(`window end     ${windowEnd}\n`);
  console.log(`completed      ${ok.length}/${outcomes.length}`);
  console.log(`images ready   ${totalImages}`);
  console.log(
    `actual cost    ~$${(totalImages * TURBO_USD_PER_IMAGE).toFixed(2)} (verify against fal /v1/models/usage)`
  );
  console.log(
    `wall clock     p50 ${(percentile(durations, 50) / 1000).toFixed(1)}s · p95 ${(percentile(durations, 95) / 1000).toFixed(1)}s · max ${(Math.max(...durations) / 1000).toFixed(1)}s`
  );

  for (const o of outcomes.filter((x) => !x.ok)) {
    console.log(
      `  FAILED #${o.index} ${o.id ?? '(never created)'} — ${o.error ?? 'unknown'}`
    );
  }

  console.log(
    `\nQuery hangs for this arm with the Workers Observability window:\n  from ${windowStart}\n  to   ${windowEnd}\n  filter $metadata.message includes "had hung and would never generate a response"`
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
