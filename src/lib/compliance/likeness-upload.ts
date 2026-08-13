/**
 * Server-side likeness attach gate (#1180).
 *
 * Identity + a recorded portrait-rights attestation must hold before any
 * path writes a real person's image into the talent library. The create
 * dialog, add-media dialog, and the public API all go through here so a
 * direct server-fn call cannot skip the checkbox.
 */

import { statementFor, statementHash } from '@/lib/compliance/attestations';
import { requirePortraitUploadAllowed } from '@/lib/compliance/generation-gate';
import type { ScopedDb } from '@/lib/db/scoped';
import { AttestationRequiredError, ValidationError } from '@/lib/errors';
import { z } from 'zod';

export const portraitAttestationSchema = z.object({
  statementVersion: z.string().min(1).max(60),
  authorizationBasis: z.string().min(1).max(500),
});

export type PortraitAttestationInput = z.infer<
  typeof portraitAttestationSchema
>;

export type LikenessRequestContext = {
  ipAddress?: string | null;
  userAgent?: string | null;
};

/**
 * Throw unless the account may attach a likeness and the request carries
 * the attestation fields the stored evidence needs.
 */
export async function requireLikenessAttachment(opts: {
  userId: string;
  teamId: string;
  attestation: PortraitAttestationInput | undefined;
}): Promise<PortraitAttestationInput> {
  await requirePortraitUploadAllowed({
    userId: opts.userId,
    teamId: opts.teamId,
  });
  if (!opts.attestation?.authorizationBasis.trim()) {
    throw new AttestationRequiredError(
      'A rights attestation is required for this upload'
    );
  }
  return {
    statementVersion: opts.attestation.statementVersion,
    authorizationBasis: opts.attestation.authorizationBasis.trim(),
  };
}

/** Persist the portrait-rights statement against a talent we just wrote. */
export async function recordPortraitAttestation(opts: {
  scopedDb: ScopedDb;
  subjectId: string;
  attestation: PortraitAttestationInput;
  request?: LikenessRequestContext;
}): Promise<void> {
  const statement = statementFor({
    subjectType: 'talent',
    depictsRealPerson: true,
  });
  if (statement.version !== opts.attestation.statementVersion) {
    throw new ValidationError(
      `Attestation version mismatch: expected ${statement.version}`
    );
  }
  await opts.scopedDb.compliance.attestations.record({
    subjectType: 'talent',
    subjectId: opts.subjectId,
    statementVersion: statement.version,
    statementSha256: await statementHash(statement),
    depictsRealPerson: true,
    authorizationBasis: opts.attestation.authorizationBasis,
    ipAddress: opts.request?.ipAddress ?? null,
    userAgent: opts.request?.userAgent ?? null,
  });
}
