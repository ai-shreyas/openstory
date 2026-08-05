import { describe, expect, it } from 'vitest';
import { createStyleSchema, updateStyleSchema } from './style.schemas';

const baseConfig = {
  mood: 'neutral',
  artStyle: 'cinematic',
  lighting: 'natural',
  colorPalette: ['#000', '#fff'],
  cameraWork: 'static',
  referenceFilms: [],
  colorGrading: 'neutral',
};

// Every SERVER_MANAGED_COLUMNS entry, injected as a malicious payload — the
// tests pin the full omit list, so dropping any entry fails here.
const serverManagedPayload = {
  id: 'attacker-chosen-id',
  isPublic: true,
  isTemplate: true,
  teamId: 'other-team',
  createdBy: 'other-user',
  createdAt: new Date(0),
  updatedAt: new Date(0),
  usageCount: 99,
  version: 99,
  sortOrder: 1,
};

describe('style schemas', () => {
  it('strips client-provided server-managed columns when creating a style', () => {
    const parsed = createStyleSchema.parse({
      name: 'Team Style',
      config: baseConfig,
      ...serverManagedPayload,
    });

    expect(parsed).toMatchObject({
      name: 'Team Style',
      config: baseConfig,
    });
    for (const column of Object.keys(serverManagedPayload)) {
      expect(parsed).not.toHaveProperty(column);
    }
  });

  it('strips client-provided server-managed columns when updating a style', () => {
    const parsed = updateStyleSchema.parse({
      name: 'Updated Style',
      ...serverManagedPayload,
    });

    expect(parsed).toEqual({ name: 'Updated Style' });
  });
});
