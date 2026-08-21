import { describe, expect, it, vi } from 'vitest';
import type { Style } from '@/lib/db/schema/libraries';
import { apiCreateStyleSchema } from './style-input-schema';

const V2_CONFIG = {
  version: 2,
  look: {
    mood: 'rain-slick noir',
    artStyle: 'photorealistic',
    lighting: 'neon practicals',
    colorPalette: ['#0a0a12', '#00e5ff', '#ff2bd6'],
    colorGrading: 'teal-magenta split',
  },
  motion: { camera: 'handheld, close', pace: 'measured', energy: 3 },
};

const LLM_RESPONSE = {
  name: 'Model Name',
  description: 'Derived description.',
  category: 'film',
  tags: ['noir', 'neon'],
  mood: 'rain-slick noir',
  artStyle: 'photorealistic',
  medium: '',
  lighting: 'neon practicals',
  colorPalette: ['#0a0a12', '#00e5ff'],
  colorGrading: 'teal-magenta split',
  camera: 'handheld',
  shots: '',
  pace: 'measured',
  energy: 3,
  references: ['rain-slicked streets'],
};

const callLLMStream = vi.fn();
const prepareBilling = vi.fn();
vi.doMock('@/lib/ai/llm-client', () => ({
  callLLMStream,
  llmCostFromUsage: () => 0,
  RECOMMENDED_MODELS: { structured: 'test/model' },
}));
vi.doMock('@/functions/ai', () => ({ prepareBilling }));

const { createStyle, styleDocument } = await import('./styles');
type StyleContext = Parameters<typeof createStyle>[1];

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- minimal fixture: the document reads only the listed columns
const ROW = {
  id: '01STYLE',
  teamId: 'team',
  name: 'Neon',
  description: null,
  category: 'film',
  tags: ['noir'],
  useCases: null,
  config: V2_CONFIG,
  isTemplate: false,
  defaultAspectRatio: null,
  recommendedImageModel: null,
  recommendedVideoModel: null,
  previewUrl: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
} as unknown as Style;

function ctx() {
  const create = vi.fn(async (data: Partial<Style>) => ({ ...ROW, ...data }));
  return {
    create,
    ctx: {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- minimal fixture: prepareBilling is mocked, only styles.create is reached
      scopedDb: { styles: { create } } as unknown as StyleContext['scopedDb'],
      user: { id: 'user' },
      teamId: 'team',
    },
  };
}

describe('apiCreateStyleSchema', () => {
  it('accepts exactly one of brief or config', () => {
    expect(
      apiCreateStyleSchema.safeParse({ name: 'A', brief: 'x'.repeat(10) })
        .success
    ).toBe(true);
    expect(
      apiCreateStyleSchema.safeParse({ name: 'A', config: V2_CONFIG }).success
    ).toBe(true);
    expect(apiCreateStyleSchema.safeParse({ name: 'A' }).success).toBe(false);
    expect(
      apiCreateStyleSchema.safeParse({
        name: 'A',
        brief: 'x'.repeat(10),
        config: V2_CONFIG,
      }).success
    ).toBe(false);
  });

  it('rejects a stored v1 config and unknown server-managed fields are ignored', () => {
    expect(
      apiCreateStyleSchema.safeParse({
        name: 'A',
        config: { ...V2_CONFIG, version: 1 },
      }).success
    ).toBe(false);
    const parsed = apiCreateStyleSchema.parse({
      name: 'A',
      config: V2_CONFIG,
      isPublic: true,
      sequenceId: 'seq',
      usageCount: 99,
    });
    expect(parsed).not.toHaveProperty('isPublic');
    expect(parsed).not.toHaveProperty('sequenceId');
    expect(parsed).not.toHaveProperty('usageCount');
  });
});

describe('createStyle', () => {
  it('config path: persists without an LLM call, defaults lists, never sets server-managed columns', async () => {
    const { create, ctx: c } = ctx();
    await createStyle(
      apiCreateStyleSchema.parse({
        name: 'Neon',
        config: V2_CONFIG,
        category: 'film',
      }),
      c
    );
    expect(callLLMStream).not.toHaveBeenCalled();
    expect(prepareBilling).not.toHaveBeenCalled();
    const row = create.mock.calls[0]?.[0] ?? {};
    expect(row).toMatchObject({
      name: 'Neon',
      category: 'film',
      tags: [],
      useCases: [],
      config: V2_CONFIG,
    });
    for (const k of [
      'isPublic',
      'isTemplate',
      'sequenceId',
      'usageCount',
      'sortOrder',
      'version',
    ]) {
      expect(row).not.toHaveProperty(k);
    }
  });

  it('brief path: bills, calls the LLM, keeps the caller name, fills the rest from the model', async () => {
    const deduct = vi.fn();
    prepareBilling.mockResolvedValue({
      llmKey: { source: 'platform' },
      deduct,
    });
    callLLMStream.mockImplementation(async function* () {
      yield { done: true, parsed: LLM_RESPONSE, usage: {} };
    });
    const { create, ctx: c } = ctx();
    await createStyle(
      apiCreateStyleSchema.parse({
        name: 'Caller Name',
        brief: 'Wet asphalt, neon practicals.',
      }),
      c
    );
    expect(prepareBilling).toHaveBeenCalledOnce();
    expect(deduct).toHaveBeenCalledOnce();
    const row = create.mock.calls[0]?.[0] ?? {};
    expect(row).toMatchObject({
      name: 'Caller Name',
      description: 'Derived description.',
      category: 'film',
      tags: ['noir', 'neon'],
    });
    expect(row).toMatchObject({ config: { version: 2 } });
  });
});

describe('styleDocument', () => {
  it('links self and a create-sequence affordance pre-filled with the id', () => {
    const doc = styleDocument(ROW);
    expect(doc._links.self?.href).toBe('/api/v1/styles/01STYLE');
    expect(doc._links['create-sequence']?.examples?.[0]).toMatchObject({
      style: '01STYLE',
    });
    expect(doc.useCases).toEqual([]);
    expect(doc.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });
});
