/**
 * One-off: second soften pass on the two still-flagged Blue Sweater shots.
 *   bun --env-file=.env.local scripts/second-soften-fails.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { isContentRejectionError } from '@/lib/ai/content-rejection';
import { createAdapter, getPlatformLlmKey } from '@/lib/ai/create-adapter';
import { extractFalErrorMessage } from '@/lib/ai/fal-error';
import { DEFAULT_ANALYSIS_MODEL } from '@/lib/ai/models.config';
import { isValidTextToImageModel } from '@/lib/ai/models';
import {
  DEFAULT_IMAGE_SIZE,
  type ImageSize,
} from '@/lib/constants/aspect-ratios';
import { generateImageWithProvider } from '@/lib/image/image-generation';
import { getChatPrompt } from '@/lib/prompts';
import { chat } from '@tanstack/ai';
import { z } from 'zod';

const schema = z.object({ prompt: z.string() });
const OUT = '/tmp/second-soften-report.json';

const attemptSchema = z.object({
  ok: z.boolean(),
  contentFlag: z.boolean(),
  error: z.string().optional(),
  url: z.string().optional(),
});
type Attempt = z.infer<typeof attemptSchema>;

const firstReportRowSchema = z.object({
  n: z.number(),
  shotId: z.string(),
  model: z.string(),
  originalPrompt: z.string(),
  original: attemptSchema,
  softenedPrompt: z.string().optional(),
  softened: attemptSchema.optional(),
});

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
  model: Parameters<typeof generateImageWithProvider>[0]['model'],
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
  if (!llmKey) throw new Error('No LLM key');
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
  if (!softened) throw new Error('empty soften');
  return softened;
}

const report = firstReportRowSchema
  .array()
  .parse(
    JSON.parse(readFileSync('/tmp/content-flag-replay-report.json', 'utf8'))
  );

const stuck = report.filter(
  (r) => r.original.contentFlag && r.softened && !r.softened.ok
);
console.log(`second-soften on ${stuck.length} still-flagged`);

const rows = await Promise.all(
  stuck.map(async (row) => {
    const model = isValidTextToImageModel(row.model) ? row.model : null;
    if (!model || !row.softenedPrompt || !row.softened) {
      return { n: row.n, error: 'missing first soften' };
    }
    const imageSize = imageSizeFor(row.softenedPrompt);
    const firstRejection =
      row.softened.error ??
      'The content could not be processed because it contained material flagged by a content checker.';
    console.log(`[${row.n}] soften #2 on ${row.shotId}`);
    let secondPrompt: string;
    try {
      secondPrompt = await softenPrompt(row.softenedPrompt, firstRejection);
    } catch (error) {
      console.log(
        `[${row.n}] soften #2 LLM failed`,
        extractFalErrorMessage(error)
      );
      return {
        n: row.n,
        shotId: row.shotId,
        model,
        firstSoftenedPrompt: row.softenedPrompt,
        secondSoftenError: extractFalErrorMessage(error),
      };
    }
    const unchanged = secondPrompt === row.softenedPrompt.trim();
    console.log(
      `[${row.n}] soften #2 ${secondPrompt.length} chars unchanged=${unchanged}`
    );
    const second = await tryGenerate(model, secondPrompt, imageSize);
    console.log(
      `[${row.n}] gen #2: ${second.ok ? 'PASS' : second.contentFlag ? 'FLAG' : 'FAIL'} ${second.url ?? second.error ?? ''}`
    );
    return {
      n: row.n,
      shotId: row.shotId,
      model,
      originalPrompt: row.originalPrompt,
      firstSoftenedPrompt: row.softenedPrompt,
      firstSoftened: row.softened,
      secondPrompt,
      unchanged,
      second,
    };
  })
);

writeFileSync(OUT, JSON.stringify(rows, null, 2));
console.log('wrote', OUT);
