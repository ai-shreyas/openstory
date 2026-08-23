import { describe, expect, it } from 'vitest';
import {
  buildTalentVisionMessages,
  talentMediaAnalysisSchema,
} from './talent-vision';

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
