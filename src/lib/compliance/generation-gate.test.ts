import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AccountRestrictedError,
  IdentityVerificationRequiredError,
} from '@/lib/errors';
import type { EnforcementAction } from '@/lib/db/schema/compliance';
import type { IdentityVerification } from '@/lib/db/schema/compliance';

const mockLoadComplianceRecords = vi.fn();
const mockComplianceEnv = vi.fn();

vi.doMock('@/lib/db/scoped', () => ({
  loadComplianceRecords: mockLoadComplianceRecords,
}));
vi.doMock('@/lib/compliance/config', () => ({
  complianceEnv: mockComplianceEnv,
}));

const { requireGenerationAllowed, requirePortraitUploadAllowed } =
  await import('./generation-gate');

const USER_ID = 'user_1';
const TEAM_ID = 'team_1';
const NOW = new Date('2026-08-12T12:00:00Z');

function enforcementRow(
  overrides: Partial<EnforcementAction> = {}
): EnforcementAction {
  return {
    id: 'enf_1',
    subjectUserId: USER_ID,
    subjectTeamId: null,
    action: 'generation_suspended',
    reason: 'portrait_rights',
    notes: null,
    reportId: null,
    actorUserId: 'admin_1',
    appliedBySystem: null,
    effectiveAt: new Date(NOW.getTime() - 60_000),
    expiresAt: null,
    revokedAt: null,
    revokedByUserId: null,
    revokedReason: null,
    notifiedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function verifiedRow(
  overrides: Partial<IdentityVerification> = {}
): IdentityVerification {
  return {
    id: 'idv_1',
    userId: USER_ID,
    teamId: TEAM_ID,
    provider: 'manual_review',
    providerRef: null,
    status: 'verified',
    method: 'document_and_liveness',
    subjectNameSha256: null,
    subjectCountry: null,
    rejectionReason: null,
    verifiedAt: new Date(NOW.getTime() - 60_000),
    expiresAt: null,
    revokedAt: null,
    revokedByUserId: null,
    revokedReason: null,
    ipAddress: null,
    userAgent: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  mockLoadComplianceRecords.mockReset();
  mockComplianceEnv.mockReset();
  mockComplianceEnv.mockReturnValue('portrait_and_restricted');
});

describe('requireGenerationAllowed', () => {
  it('throws ACCOUNT_RESTRICTED before asking for identity', async () => {
    mockLoadComplianceRecords.mockResolvedValue({
      enforcement: [enforcementRow()],
      verifications: [],
    });

    await expect(
      requireGenerationAllowed({
        userId: USER_ID,
        teamId: TEAM_ID,
        provider: 'modelark',
        model: 'seedance',
      })
    ).rejects.toBeInstanceOf(AccountRestrictedError);
  });

  it('requires identity for a restricted provider when unverified', async () => {
    mockLoadComplianceRecords.mockResolvedValue({
      enforcement: [],
      verifications: [],
    });

    try {
      await requireGenerationAllowed({
        userId: USER_ID,
        teamId: TEAM_ID,
        provider: 'modelark',
        model: 'seedance',
      });
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(IdentityVerificationRequiredError);
      expect(error).toMatchObject({
        details: {
          verifyPath: '/settings/identity',
          pending: false,
        },
      });
    }
  });

  it('allows an ordinary fal model under the default policy', async () => {
    mockLoadComplianceRecords.mockResolvedValue({
      enforcement: [],
      verifications: [],
    });

    await expect(
      requireGenerationAllowed({
        userId: USER_ID,
        teamId: TEAM_ID,
        provider: 'fal',
        model: 'fal-ai/flux/dev',
      })
    ).resolves.toBeUndefined();
  });

  it('allows a restricted model when the account is verified', async () => {
    mockLoadComplianceRecords.mockResolvedValue({
      enforcement: [],
      verifications: [verifiedRow()],
    });

    await expect(
      requireGenerationAllowed({
        userId: USER_ID,
        teamId: TEAM_ID,
        provider: 'modelark',
        model: 'seedance',
      })
    ).resolves.toBeUndefined();
  });
});

describe('requirePortraitUploadAllowed', () => {
  it('requires identity for a likeness upload when unverified', async () => {
    mockLoadComplianceRecords.mockResolvedValue({
      enforcement: [],
      verifications: [],
    });

    await expect(
      requirePortraitUploadAllowed({ userId: USER_ID, teamId: TEAM_ID })
    ).rejects.toBeInstanceOf(IdentityVerificationRequiredError);
  });

  it('passes when the account is verified', async () => {
    mockLoadComplianceRecords.mockResolvedValue({
      enforcement: [],
      verifications: [verifiedRow()],
    });

    await expect(
      requirePortraitUploadAllowed({ userId: USER_ID, teamId: TEAM_ID })
    ).resolves.toBeUndefined();
  });
});
