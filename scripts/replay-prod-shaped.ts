// @ts-nocheck — one-off replay, not part of the app typecheck.
/**
 * Prod-shaped replay: same refs + prompt builder as ImageWorkflow.
 *
 *   R2_PUBLIC_STORAGE_DOMAIN=storage.openstory.so \
 *     bun --env-file=.env.local scripts/replay-prod-shaped.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { isContentRejectionError } from '@/lib/ai/content-rejection';
import { createAdapter, getPlatformLlmKey } from '@/lib/ai/create-adapter';
import { extractFalErrorMessage } from '@/lib/ai/fal-error';
import { DEFAULT_ANALYSIS_MODEL } from '@/lib/ai/models.config';
import {
  IMAGE_MODELS,
  isValidTextToImageModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import {
  aspectRatioSchema,
  aspectRatioToImageSize,
  DEFAULT_ASPECT_RATIO,
  type ImageSize,
} from '@/lib/constants/aspect-ratios';
import { generateImageWithProvider } from '@/lib/image/image-generation';
import { buildCharacterReferenceImages } from '@/lib/prompts/character-prompt';
import { buildElementReferenceImages } from '@/lib/prompts/element-prompt';
import { buildLocationReferenceImages } from '@/lib/prompts/location-prompt';
import {
  buildReferenceImagePrompt,
  type ReferenceImageDescription,
} from '@/lib/prompts/reference-image-prompt';
import { getChatPrompt } from '@/lib/prompts';
import {
  matchCharactersToScene,
  matchElementsToShotImage,
  matchLocationsToScene,
} from '@/lib/workflows/scene-matching';
import { chat } from '@tanstack/ai';
import { z } from 'zod';

const CASES_PATH = '/tmp/content-fails-unique.json';
const OUT_PATH = '/tmp/replay-prod-shaped.json';
const schema = z.object({ prompt: z.string() });

const attemptSchema = z.object({
  ok: z.boolean(),
  contentFlag: z.boolean(),
  error: z.string().optional(),
  url: z.string().optional(),
});
type Attempt = z.infer<typeof attemptSchema>;

const failRowSchema = z.object({
  shot_id: z.string(),
  sequence_id: z.string(),
  model: z.string(),
  error: z.string(),
  prompt: z.string().nullable(),
});
const continuitySchema = z.object({
  characterTags: z.array(z.string()).optional(),
  environmentTag: z.string().optional(),
  elementTags: z.array(z.string()).optional(),
});

function d1Results<T>(path: string, itemSchema: z.ZodType<T>): T[] {
  const t = readFileSync(path, 'utf8');
  const rows = z
    .array(z.object({ results: z.array(itemSchema) }))
    .parse(JSON.parse(t.slice(t.indexOf('['))));
  const first = rows[0];
  if (!first) throw new Error(`no D1 results in ${path}`);
  return first.results;
}

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

async function tryGenerate(
  model: TextToImageModel,
  prompt: string,
  imageSize: ImageSize,
  refs: ReferenceImageDescription[]
): Promise<Attempt> {
  const { prompt: enhanced, referenceUrls } = buildReferenceImagePrompt(
    prompt,
    refs,
    IMAGE_MODELS[model].maxPromptLength
  );
  try {
    const result = await generateImageWithProvider({
      model,
      prompt: enhanced,
      imageSize,
      numImages: 1,
      referenceImageUrls: referenceUrls.length > 0 ? referenceUrls : undefined,
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
  if (!softened || softened === prompt.trim()) {
    throw new Error('softener returned empty or unchanged prompt');
  }
  return softened;
}

function fmt(a: Attempt): string {
  if (a.ok) return `PASS ${a.url ?? ''}`;
  if (a.contentFlag) return `FLAG ${a.error ?? ''}`;
  return `FAIL ${a.error ?? ''}`;
}

const charRowSchema = z.object({
  sequence_id: z.string(),
  name: z.string(),
  sheet_status: z.string(),
  sheet_image_url: z.string().nullable(),
  physical_description: z.string().nullable(),
  character_id: z.string(),
  consistency_tag: z.string().nullable(),
});
const locRowSchema = z.object({
  sequence_id: z.string(),
  name: z.string(),
  location_id: z.string(),
  consistency_tag: z.string().nullable(),
  description: z.string().nullable(),
  reference_image_url: z.string().nullable(),
});
const elRowSchema = z.object({
  sequence_id: z.string(),
  token: z.string(),
  description: z.string().nullable(),
  image_url: z.string(),
  consistency_tag: z.string().nullable(),
});
const shotRowSchema = z.object({
  shot_id: z.string(),
  sequence_id: z.string(),
  location: z.string().nullable(),
  continuity: z.string().nullable(),
});
const seqRowSchema = z.object({
  id: z.string(),
  aspect_ratio: z.string(),
});
const cases = failRowSchema
  .array()
  .parse(JSON.parse(readFileSync(CASES_PATH, 'utf8')))
  .filter((r) => r.prompt?.trim())
  .slice(0, 20);
const chars = d1Results('/tmp/d1-chars.raw.json', charRowSchema);
const locs = d1Results('/tmp/d1-locs.raw.json', locRowSchema);
const els = d1Results('/tmp/d1-els.raw.json', elRowSchema);
const shotRows = d1Results('/tmp/d1-shots.raw.json', shotRowSchema);
const seqs = d1Results('/tmp/d1-seqs.raw.json', seqRowSchema);

const shotsById = new Map(shotRows.map((s) => [s.shot_id, s]));
const seqById = new Map(seqs.map((s) => [s.id, s]));

function refsFor(shotId: string, sequenceId: string, prompt: string) {
  const shot = shotsById.get(shotId);
  const continuity = shot?.continuity
    ? continuitySchema.parse(JSON.parse(shot.continuity))
    : {};
  const seqChars = chars
    .filter((c) => c.sequence_id === sequenceId)
    .map((c) => ({
      id: c.character_id,
      characterId: c.character_id,
      name: c.name,
      sheetImageUrl: c.sheet_image_url,
      sheetStatus: 'completed' as const,
      sheetInputHash: null,
      physicalDescription: c.physical_description,
      consistencyTag: c.consistency_tag,
    }));
  const seqLocs = locs
    .filter((l) => l.sequence_id === sequenceId)
    .map((l) => ({
      id: l.location_id,
      locationId: l.location_id,
      name: l.name,
      consistencyTag: l.consistency_tag,
      description: l.description,
      referenceImageUrl: l.reference_image_url,
    }));
  const seqEls = els
    .filter((e) => e.sequence_id === sequenceId)
    .map((e) => ({
      id: e.token,
      token: e.token,
      description: e.description,
      imageUrl: e.image_url,
      consistencyTag: e.consistency_tag,
    }));

  const matchedCharacters = matchCharactersToScene(
    seqChars,
    continuity.characterTags ?? []
  );
  const matchedLocations = matchLocationsToScene(
    seqLocs,
    continuity.environmentTag ?? '',
    shot?.location ?? ''
  );
  const matchedElements = matchElementsToShotImage(seqEls, {
    visualPrompt: prompt,
    elementTags: continuity.elementTags,
  });

  const refs: ReferenceImageDescription[] = [
    ...buildCharacterReferenceImages(matchedCharacters),
    ...buildLocationReferenceImages(matchedLocations),
    ...buildElementReferenceImages(matchedElements),
  ];
  return {
    refs,
    summary: refs.map(
      (r) => `${r.role}:${r.token ?? r.description.slice(0, 40)}`
    ),
  };
}

type RowOut = {
  n: number;
  shotId: string;
  sequenceId: string;
  model: string;
  prodError: string;
  originalPrompt: string;
  imageSize: ImageSize;
  refs: string[];
  original: Attempt;
  grokOriginal?: Attempt;
  nanoOriginal?: Attempt;
  softenedPrompt?: string;
  softenError?: string;
  softened?: Attempt;
  grokSoftened?: Attempt;
};

const report: RowOut[] = [];
const save = () => writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));

const prepared = cases.map((row, i) => {
  const prompt = row.prompt?.trim() ?? '';
  const model = isValidTextToImageModel(row.model) ? row.model : null;
  const parsedAspect = aspectRatioSchema.safeParse(
    seqById.get(row.sequence_id)?.aspect_ratio ?? DEFAULT_ASPECT_RATIO
  );
  const imageSize = aspectRatioToImageSize(
    parsedAspect.success ? parsedAspect.data : DEFAULT_ASPECT_RATIO
  );
  const { refs, summary } = refsFor(row.shot_id, row.sequence_id, prompt);
  return { row, n: i + 1, prompt, model, imageSize, refs, summary };
});

console.log(
  `Prod-shaped replay: ${prepared.length} shots, refs via storage.openstory.so`
);
for (const p of prepared) {
  console.log(
    `[${p.n}] ${p.row.model} refs=${p.summary.join(' | ') || '(none)'}`
  );
}

for (const p of prepared) {
  report.push({
    n: p.n,
    shotId: p.row.shot_id,
    sequenceId: p.row.sequence_id,
    model: p.row.model,
    prodError: p.row.error,
    originalPrompt: p.prompt,
    imageSize: p.imageSize,
    refs: p.summary,
    original: p.model
      ? { ok: false, contentFlag: false, error: 'pending' }
      : {
          ok: false,
          contentFlag: false,
          error: `unknown model ${p.row.model}`,
        },
  });
}
save();

console.log(
  '\n=== wave 1: original / grok / nano on original prompt + refs ==='
);

await Promise.all(
  prepared.flatMap((p) => {
    if (!p.model) return [];
    const row = report.find((r) => r.n === p.n);
    if (!row) return [];
    const run = async (
      label: string,
      model: TextToImageModel,
      assign: (a: Attempt) => void
    ) => {
      console.log(`[${p.n} ${label}] start`);
      const attempt = await tryGenerate(model, p.prompt, p.imageSize, p.refs);
      console.log(`[${p.n} ${label}] ${fmt(attempt)}`);
      assign(attempt);
      save();
    };
    return [
      run('original', p.model, (a) => {
        row.original = a;
      }),
      run('grok', 'grok_imagine_image', (a) => {
        row.grokOriginal = a;
      }),
      run('nano', 'nano_banana_2', (a) => {
        row.nanoOriginal = a;
      }),
    ];
  })
);

const flagged = report.filter((r) => r.original.contentFlag);
console.log(
  `\n=== wave 2: soften + retry (${flagged.length} original-model flags) ===`
);

await Promise.all(
  flagged.map(async (row) => {
    const p = prepared.find((x) => x.n === row.n);
    if (!p?.model) return;
    try {
      const softened = await softenPrompt(
        row.originalPrompt,
        row.original.error ?? row.prodError
      );
      row.softenedPrompt = softened;
      console.log(`[${row.n}] softened (${softened.length} chars)`);
      row.softened = await tryGenerate(p.model, softened, p.imageSize, p.refs);
      console.log(`[${row.n} soften/${p.model}] ${fmt(row.softened)}`);
      if (row.grokOriginal && !row.grokOriginal.ok) {
        row.grokSoftened = await tryGenerate(
          'grok_imagine_image',
          softened,
          p.imageSize,
          p.refs
        );
        console.log(`[${row.n} soften/grok] ${fmt(row.grokSoftened)}`);
      }
    } catch (error) {
      row.softenError = extractFalErrorMessage(error);
      console.log(`[${row.n}] soften LLM failed: ${row.softenError}`);
    }
    save();
  })
);

const origFlag = report.filter((r) => r.original.contentFlag).length;
const grokPass = report.filter((r) => r.grokOriginal?.ok).length;
const nanoPass = report.filter((r) => r.nanoOriginal?.ok).length;
const grokSaves = report.filter(
  (r) => r.original.contentFlag && r.grokOriginal?.ok
).length;
const nanoSaves = report.filter(
  (r) => r.original.contentFlag && r.nanoOriginal?.ok
).length;
const softenRescue = report.filter(
  (r) => r.original.contentFlag && r.softened?.ok
).length;
console.log('\n=== summary ===');
console.log(`n=${report.length} originalFlag=${origFlag}`);
console.log(
  `grok pass=${grokPass} saves(original FLAG→grok PASS)=${grokSaves}`
);
console.log(`nano pass=${nanoPass} saves=${nanoSaves}`);
console.log(`soften on original model rescued=${softenRescue}`);
console.log(`wrote ${OUT_PATH}`);
