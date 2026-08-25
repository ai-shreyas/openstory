/**
 * One-off: replay still-flagged Blue Sweater prompts on another image model.
 *   bun --env-file=.env.local scripts/swap-model-flagged.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { isContentRejectionError } from '@/lib/ai/content-rejection';
import { extractFalErrorMessage } from '@/lib/ai/fal-error';
import {
  isValidTextToImageModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import {
  DEFAULT_IMAGE_SIZE,
  type ImageSize,
} from '@/lib/constants/aspect-ratios';
import { generateImageWithProvider } from '@/lib/image/image-generation';

const MODEL_ARG = process.argv[2] ?? 'grok_imagine_image';
if (!isValidTextToImageModel(MODEL_ARG)) {
  throw new Error(`unknown image model ${MODEL_ARG}`);
}
const MODEL: TextToImageModel = MODEL_ARG;
const OUT = `/tmp/swap-model-${MODEL}.json`;

type Attempt = {
  ok: boolean;
  contentFlag: boolean;
  error?: string;
  url?: string;
};

function imageSizeFor(prompt: string): ImageSize {
  if (/9:16|vertical 9:16|portrait/i.test(prompt)) return 'portrait_16_9';
  if (/1:1|square/i.test(prompt)) return 'square_hd';
  return DEFAULT_IMAGE_SIZE;
}

async function tryGenerate(prompt: string): Promise<Attempt> {
  try {
    const result = await generateImageWithProvider({
      model: MODEL,
      prompt,
      imageSize: imageSizeFor(prompt),
      numImages: 1,
    });
    return { ok: true, contentFlag: false, url: result.imageUrls[0] };
  } catch (error) {
    return {
      ok: false,
      contentFlag: isContentRejectionError(error),
      error: extractFalErrorMessage(error),
    };
  }
}

const first = JSON.parse(
  readFileSync('/tmp/content-flag-replay-report.json', 'utf8')
) as Array<{
  n: number;
  shotId: string;
  originalPrompt: string;
  original: Attempt;
  softenedPrompt?: string;
  softened?: Attempt;
}>;

const second = JSON.parse(
  readFileSync('/tmp/second-soften-report.json', 'utf8')
) as Array<{
  n: number;
  shotId: string;
  secondPrompt?: string;
  second?: Attempt;
}>;

const jobs: Array<{
  n: number;
  shotId: string;
  pass: 'original' | 'soften1' | 'soften2';
  prompt: string;
  gpt: Attempt;
}> = [];

for (const row of first.filter(
  (r) => r.original.contentFlag && r.softened && !r.softened.ok
)) {
  jobs.push({
    n: row.n,
    shotId: row.shotId,
    pass: 'original',
    prompt: row.originalPrompt,
    gpt: row.original,
  });
  if (row.softenedPrompt && row.softened) {
    jobs.push({
      n: row.n,
      shotId: row.shotId,
      pass: 'soften1',
      prompt: row.softenedPrompt,
      gpt: row.softened,
    });
  }
}

for (const row of second) {
  if (row.secondPrompt && row.second && !row.second.ok) {
    jobs.push({
      n: row.n,
      shotId: row.shotId,
      pass: 'soften2',
      prompt: row.secondPrompt,
      gpt: row.second,
    });
  }
}

console.log(`${MODEL} — ${jobs.length} still-flagged prompts in parallel`);

const results = await Promise.all(
  jobs.map(async (job) => {
    console.log(`[${job.n} ${job.pass}] start ${job.shotId}`);
    const attempt = await tryGenerate(job.prompt);
    const tag = attempt.ok
      ? `PASS ${attempt.url ?? ''}`
      : attempt.contentFlag
        ? `FLAG ${attempt.error ?? ''}`
        : `FAIL ${attempt.error ?? ''}`;
    console.log(`[${job.n} ${job.pass}] ${tag}`);
    return { ...job, model: MODEL, swapped: attempt };
  })
);

writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log('wrote', OUT);
