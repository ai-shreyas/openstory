/**
 * One-off: replay last N prod content-flagged stills.
 * Original generate, then the #1272 softener, then generate again.
 *
 *   bun --env-file=.env.local scripts/replay-content-flag-fails.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { isContentRejectionError } from '@/lib/ai/content-rejection';
import { createAdapter, getPlatformLlmKey } from '@/lib/ai/create-adapter';
import { extractFalErrorMessage } from '@/lib/ai/fal-error';
import { DEFAULT_ANALYSIS_MODEL } from '@/lib/ai/models.config';
import {
  isValidTextToImageModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import {
  DEFAULT_IMAGE_SIZE,
  type ImageSize,
} from '@/lib/constants/aspect-ratios';
import { generateImageWithProvider } from '@/lib/image/image-generation';
import { getChatPrompt } from '@/lib/prompts';
import { chat } from '@tanstack/ai';
import { z } from 'zod';

const failRowSchema = z.object({
  variant_id: z.string(),
  frame_id: z.string(),
  sequence_id: z.string(),
  shot_id: z.string(),
  model: z.string(),
  error: z.string(),
  prompt: z.string().nullable(),
});
type FailRow = z.infer<typeof failRowSchema>;

const attemptSchema = z.object({
  ok: z.boolean(),
  contentFlag: z.boolean(),
  error: z.string().optional(),
  url: z.string().optional(),
});
type Attempt = z.infer<typeof attemptSchema>;

const schema = z.object({ prompt: z.string() });
const CASES_PATH = '/tmp/content-fails-unique.json';
const OUT_PATH = '/tmp/content-flag-replay-report.json';

function toChatPayload(
  messages: Awaited<ReturnType<typeof getChatPrompt>>['messages']
): {
  systemPrompts: string[];
  chatMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
} {
  const systemPrompts: string[] = [];
  const chatMessages: Array<{ role: 'user' | 'assistant'; content: string }> =
    [];
  for (const m of messages) {
    const content = typeof m.content === 'string' ? m.content : '';
    if (m.role === 'system') {
      systemPrompts.push(content);
    } else {
      chatMessages.push({ role: m.role, content });
    }
  }
  return { systemPrompts, chatMessages };
}

function imageSizeFor(prompt: string): ImageSize {
  if (/9:16|vertical 9:16|portrait/i.test(prompt)) return 'portrait_16_9';
  if (/1:1|square/i.test(prompt)) return 'square_hd';
  return DEFAULT_IMAGE_SIZE;
}

async function tryGenerate(
  model: TextToImageModel,
  prompt: string,
  imageSize: ImageSize
): Promise<Attempt> {
  try {
    const result = await generateImageWithProvider({
      model,
      prompt,
      imageSize,
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

async function softenPrompt(
  prompt: string,
  rejection: string
): Promise<string> {
  const llmKey = getPlatformLlmKey(DEFAULT_ANALYSIS_MODEL);
  if (!llmKey) throw new Error('No OPENROUTER_KEY / FAL_KEY / XAI_API_KEY');
  const { messages } = await getChatPrompt('phase/soften-image-prompt-chat', {
    prompt,
    rejection,
  });
  const { systemPrompts, chatMessages } = toChatPayload(messages);
  const adapter = createAdapter(DEFAULT_ANALYSIS_MODEL, llmKey);
  const eventStream = chat({
    adapter,
    messages: chatMessages,
    systemPrompts,
    stream: true,
    outputSchema: schema,
    debug: false,
  });
  let structured: unknown;
  for await (const event of eventStream) {
    if (
      event.type === 'CUSTOM' &&
      event.name === 'structured-output.complete'
    ) {
      structured = event.value.object;
    }
  }
  const parsed = schema.parse(structured);
  const softened = parsed.prompt.trim();
  if (!softened || softened === prompt.trim()) {
    throw new Error('softener returned empty or unchanged prompt');
  }
  return softened;
}

const reportRowSchema = z.object({
  n: z.number(),
  shotId: z.string(),
  sequenceId: z.string(),
  model: z.string(),
  prodError: z.string(),
  originalPrompt: z.string(),
  original: attemptSchema,
  softenedPrompt: z.string().optional(),
  softenError: z.string().optional(),
  softened: attemptSchema.optional(),
});
type ReportRow = z.infer<typeof reportRowSchema>;

function fmtAttempt(a: Attempt): string {
  if (a.ok) return `PASS ${a.url ?? ''}`;
  if (a.contentFlag) return `CONTENT_FLAG ${a.error ?? ''}`;
  return `FAIL ${a.error ?? ''}`;
}

const rows = failRowSchema
  .array()
  .parse(JSON.parse(readFileSync(CASES_PATH, 'utf8')));
const cases = rows.filter((r) => r.prompt?.trim()).slice(0, 20);

let report: ReportRow[] = [];
try {
  report = reportRowSchema
    .array()
    .parse(JSON.parse(readFileSync(OUT_PATH, 'utf8')));
} catch {
  report = [];
}
const doneIds = new Set(report.map((r) => r.shotId));

const pending = cases
  .map((row, i) => ({ row, n: i + 1 }))
  .filter(({ row }) => !doneIds.has(row.shot_id));

console.log(
  `Replaying ${pending.length} remaining of ${cases.length} (already have ${report.length}) in parallel`
);

const save = () => writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));

async function replayOne(n: number, row: FailRow): Promise<ReportRow> {
  const prompt = row.prompt?.trim() ?? '';
  const model = isValidTextToImageModel(row.model) ? row.model : null;
  const imageSize = imageSizeFor(prompt);
  console.log(`[${n}/${cases.length}] start ${row.model} ${row.shot_id}`);
  if (!model) {
    return {
      n,
      shotId: row.shot_id,
      sequenceId: row.sequence_id,
      model: row.model,
      prodError: row.error,
      originalPrompt: prompt,
      original: {
        ok: false,
        contentFlag: false,
        error: `unknown model ${row.model}`,
      },
    };
  }

  const original = await tryGenerate(model, prompt, imageSize);
  console.log(`[${n}] original: ${fmtAttempt(original)}`);

  let softenedPrompt: string | undefined;
  let softenError: string | undefined;
  let softened: Attempt | undefined;
  try {
    softenedPrompt = await softenPrompt(prompt, original.error ?? row.error);
    console.log(`[${n}] softened (${softenedPrompt.length} chars)`);
    softened = await tryGenerate(model, softenedPrompt, imageSize);
    console.log(`[${n}] softened gen: ${fmtAttempt(softened)}`);
  } catch (error) {
    softenError = extractFalErrorMessage(error);
    console.log(`[${n}] soften LLM failed: ${softenError}`);
  }

  return {
    n,
    shotId: row.shot_id,
    sequenceId: row.sequence_id,
    model,
    prodError: row.error,
    originalPrompt: prompt,
    original,
    softenedPrompt,
    softenError,
    softened,
  };
}

const next = await Promise.all(
  pending.map(async ({ row, n }) => {
    const result = await replayOne(n, row);
    report.push(result);
    report.sort((a, b) => a.n - b.n);
    save();
    return result;
  })
);
void next;

const origFail = report.filter((r) => !r.original.ok).length;
const origFlag = report.filter((r) => r.original.contentFlag).length;
const softPass = report.filter((r) => r.softened?.ok).length;
const rescued = report.filter((r) => !r.original.ok && r.softened?.ok).length;
console.log('\n=== summary ===');
console.log(`n=${report.length}`);
console.log(`original fail=${origFail} contentFlag=${origFlag}`);
console.log(`softened pass=${softPass} rescued(fail→pass)=${rescued}`);
console.log(`wrote ${OUT_PATH}`);
