/**
 * Shared content-rejection reseeds + one softened prompt retry (#1293).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import type { ImageGenerationParams } from '@/lib/image/build-image-request';
import type { ImageGenerationResult } from '@/lib/image/image-generation';
import type { WorkflowStep } from 'cloudflare:workers';

const generateImageWithProvider = vi.fn();
vi.doMock('@/lib/image/image-generation', async () => {
  const real = await vi.importActual<
    typeof import('@/lib/image/image-generation')
  >('@/lib/image/image-generation');
  return { ...real, generateImageWithProvider };
});

const durableLLMCallCf = vi.fn();
vi.doMock('@/lib/workflows/llm-call-helper', () => ({ durableLLMCallCf }));

const { generateImageSoftening, MAX_CONTENT_ATTEMPTS } =
  await import('./content-soften');
const { NonRetryableError } = await import('cloudflare:workflows');

const stepNames: string[] = [];
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- helper only uses `do`
const step = {
  do: async <T>(name: string, fn: () => Promise<T>) => {
    stepNames.push(name);
    return fn();
  },
} as unknown as WorkflowStep;

// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- only `credentials` is read
const scopedDb = { credentials: {} } as unknown as WorkflowScopedDb;

const PARAMS: ImageGenerationParams = {
  model: 'nano_banana_2',
  prompt: 'Name: Harry Potter\nA boy wizard in school robes',
  imageSize: 'landscape_16_9',
  numImages: 1,
};

function okResult(prompt: string): ImageGenerationResult {
  return {
    imageUrls: ['https://cdn/img.jpg'],
    parameters: { ...PARAMS, prompt },
    generatedAt: '2026-08-25T00:00:00.000Z',
    processingTimeMs: 12,
    via: 'fal',
    metadata: {
      prompt,
      model: PARAMS.model,
      endpointId: 'fal-ai/nano-banana-2',
      dimensions: [],
      file_sizes: [],
      usedOwnKey: false,
    },
  };
}

const contentError = () => new Error('material flagged by a content checker.');

function run(
  overrides: Partial<Parameters<typeof generateImageSoftening>[0]> = {}
) {
  return generateImageSoftening({
    step,
    scopedDb,
    workflowRunId: 'wf-1',
    userId: 'u1',
    sequenceId: 'seq_1',
    kind: 'character-sheet',
    logTag: '[Test]',
    subject: 'sheet for Harry Potter',
    stepName: 'generate-sheet-image',
    params: PARAMS,
    ...overrides,
  });
}

beforeEach(() => {
  generateImageWithProvider.mockReset();
  durableLLMCallCf.mockReset();
  stepNames.length = 0;
});

describe('generateImageSoftening', () => {
  it('reseeds, then softens once and renders the rewritten prompt', async () => {
    generateImageWithProvider
      .mockRejectedValueOnce(contentError())
      .mockRejectedValueOnce(contentError())
      .mockRejectedValueOnce(contentError())
      .mockImplementationOnce(async (p: ImageGenerationParams) =>
        okResult(p.prompt)
      );
    durableLLMCallCf.mockResolvedValue({
      prompt: 'Name: a boy wizard\nA boy wizard in school robes',
    });

    const out = await run();

    expect(generateImageWithProvider).toHaveBeenCalledTimes(
      MAX_CONTENT_ATTEMPTS + 1
    );
    expect(out.softened).toBe(true);
    expect(out.params.prompt).toBe(
      'Name: a boy wizard\nA boy wizard in school robes'
    );
    expect(durableLLMCallCf).toHaveBeenCalledTimes(1);
    expect(durableLLMCallCf.mock.calls[0]?.[1]).toMatchObject({
      name: 'soften-generate-sheet-image',
      promptVariables: { prompt: PARAMS.prompt },
    });
    expect(stepNames).toEqual([
      'generate-sheet-image',
      'generate-sheet-image-retry-1',
      'generate-sheet-image-retry-2',
      'generate-sheet-image-softened',
    ]);
  });

  it('fails hard with the real rejection when the softened prompt is also flagged', async () => {
    generateImageWithProvider.mockRejectedValue(contentError());
    durableLLMCallCf.mockResolvedValue({ prompt: 'A boy wizard' });

    await expect(run()).rejects.toThrow(NonRetryableError);
    await expect(run()).rejects.toThrow(/softened prompt.*content checker/);
  });

  it('rethrows transient errors so Cloudflare retries the step, without softening', async () => {
    generateImageWithProvider.mockRejectedValueOnce(new Error('ECONNRESET'));

    await expect(run()).rejects.toThrow('ECONNRESET');
    expect(durableLLMCallCf).not.toHaveBeenCalled();
  });

  it('uses `rebuild` so the softened prompt keeps its reference legend', async () => {
    generateImageWithProvider
      .mockRejectedValueOnce(contentError())
      .mockRejectedValueOnce(contentError())
      .mockRejectedValueOnce(contentError())
      .mockImplementationOnce(async (p: ImageGenerationParams) =>
        okResult(p.prompt)
      );
    durableLLMCallCf.mockResolvedValue({ prompt: 'softened' });

    const out = await run({
      prompt: 'authored',
      rebuild: (p) => ({ ...PARAMS, prompt: `${p} | Image 1: HARRY` }),
    });

    expect(durableLLMCallCf.mock.calls[0]?.[1]).toMatchObject({
      promptVariables: { prompt: 'authored' },
    });
    expect(out.params.prompt).toBe('softened | Image 1: HARRY');
  });
});
