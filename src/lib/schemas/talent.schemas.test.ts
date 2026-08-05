import { describe, expect, it } from 'vitest';
import { createTalentSchema, updateTalentSchema } from './talent.schemas';

// Every SERVER_MANAGED_COLUMNS entry, injected as a malicious payload — the
// tests pin the full omit list, so dropping any entry fails here. isPublic is
// the security-critical one: a client-settable value would publish team
// talent into the anonymous public catalogue (same class as #869).
const serverManagedPayload = {
  id: 'attacker-chosen-id',
  isPublic: true,
  isTemplate: true,
  teamId: 'other-team',
  createdBy: 'other-user',
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

describe('talent schemas', () => {
  it('strips client-provided server-managed columns when creating talent', () => {
    const parsed = createTalentSchema.parse({
      name: 'Team Talent',
      description: 'A character',
      referenceImageUrls: ['https://example.com/ref.png'],
      ...serverManagedPayload,
    });

    expect(parsed).toMatchObject({
      name: 'Team Talent',
      description: 'A character',
      referenceImageUrls: ['https://example.com/ref.png'],
    });
    for (const column of Object.keys(serverManagedPayload)) {
      expect(parsed).not.toHaveProperty(column);
    }
  });

  it('strips client-provided server-managed columns when updating talent', () => {
    const parsed = updateTalentSchema.parse({
      name: 'Updated Talent',
      ...serverManagedPayload,
    });

    expect(parsed).toEqual({ name: 'Updated Talent' });
  });
});
