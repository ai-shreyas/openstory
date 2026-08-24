import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_VISION_MODEL } from './models.config';
import {
  buildTalentVisionMessages,
  talentMediaAnalysisSchema,
} from './talent-vision';

const talentVisionFixtureFileSchema = z.object({
  fixtures: z
    .array(
      z.object({
        match: z.object({
          userMessage: z.string(),
          model: z.string(),
        }),
        response: z.object({ content: z.string() }),
      })
    )
    .min(1),
});

const TALENT_VISION_FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../e2e/fixtures/recorded/openrouter/talent-vision/talent-vision.json'
);

describe('talentMediaAnalysisSchema', () => {
  it('accepts a full analysis object', () => {
    const parsed = talentMediaAnalysisSchema.parse({
      isCharacterSheet: true,
      suggestedName: 'Mara',
      description: 'A woman in her 30s with a sharp bob and a leather jacket.',
      age: '30s',
      gender: 'female',
      ethnicity: '',
      physicalDescription: 'Sharp bob, angular face',
      standardClothing: 'Black leather jacket, dark jeans',
      distinguishingFeatures: 'Small hoop earring',
    });
    expect(parsed.isCharacterSheet).toBe(true);
    expect(parsed.suggestedName).toBe('Mara');
  });

  it('rejects a missing isCharacterSheet flag', () => {
    expect(() =>
      talentMediaAnalysisSchema.parse({
        suggestedName: '',
        description: 'A person.',
        age: '',
        gender: '',
        ethnicity: '',
        physicalDescription: '',
        standardClothing: '',
        distinguishingFeatures: '',
      })
    ).toThrow();
  });
});

describe('buildTalentVisionMessages', () => {
  it('uses the singular prompt for one image', () => {
    const messages = buildTalentVisionMessages([
      { type: 'url', value: 'https://example.com/a.png' },
    ]);
    expect(messages[0]?.role).toBe('system');
    const user = messages[1];
    expect(user?.role).toBe('user');
    expect(Array.isArray(user?.content)).toBe(true);
    const parts = user?.content;
    if (!Array.isArray(parts)) throw new Error('expected multimodal content');
    expect(parts[0]).toEqual({
      type: 'text',
      content:
        'Analyze this talent reference: is the image already a character sheet? Describe the person.',
    });
    expect(parts).toHaveLength(2);
  });

  it('uses the plural prompt and one image part per source', () => {
    const messages = buildTalentVisionMessages([
      { type: 'url', value: 'https://example.com/a.png' },
      { type: 'url', value: 'https://example.com/b.png' },
    ]);
    const parts = messages[1]?.content;
    if (!Array.isArray(parts)) throw new Error('expected multimodal content');
    expect(parts[0]).toMatchObject({
      type: 'text',
      content: expect.stringContaining('these 2 images'),
    });
    expect(parts.filter((part) => part.type === 'image')).toHaveLength(2);
  });
});

describe('e2e talent-vision aimock fixture', () => {
  it('matches the singular prompt and parses as TalentMediaAnalysis', () => {
    const raw: unknown = JSON.parse(
      readFileSync(TALENT_VISION_FIXTURE, 'utf8')
    );
    const fixture = talentVisionFixtureFileSchema.parse(raw).fixtures[0];
    if (!fixture) throw new Error('talent-vision fixture is empty');

    const messages = buildTalentVisionMessages([
      { type: 'url', value: 'https://example.com/a.png' },
    ]);
    const parts = messages[1]?.content;
    if (!Array.isArray(parts)) throw new Error('expected multimodal content');
    const text = parts[0];
    if (text?.type !== 'text') throw new Error('expected text part');

    expect(fixture.match.userMessage).toBe(text.content);
    expect(fixture.match.model).toBe(DEFAULT_VISION_MODEL);
    expect(
      talentMediaAnalysisSchema.parse(JSON.parse(fixture.response.content))
        .isCharacterSheet
    ).toBe(false);
  });
});
