/**
 * Compliance server functions — the user's own side (#1180).
 *
 * Identity verification and rights attestations. Nothing here is admin-facing:
 * moderation lives in `./moderation`, and public report intake in
 * `./content-reports`.
 */

import { authMiddleware, authWithTeamMiddleware } from './middleware';
import {
  loadComplianceState,
  summarizeCompliance,
} from '@/lib/compliance/generation-gate';
import { ATTESTATION_SUBJECT_TYPES } from '@/lib/db/schema/compliance';
import { statementFor, statementHash } from '@/lib/compliance/attestations';
import { getVerificationPolicy } from '@/lib/compliance/identity-verification';
import { resolveVerificationAdapter } from '@/lib/compliance/verification-providers';
import { getServerAppUrl } from '@/lib/utils/environment';
import { AttestationRequiredError, ValidationError } from '@/lib/errors';
import { resolveUserTeam } from '@/lib/db/scoped';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

/** Client context for an attestation or verification — evidence, not telemetry. */
function requestContext(): {
  ipAddress: string | null;
  userAgent: string | null;
} {
  const request = getRequest();
  return {
    // Cloudflare's own header, not X-Forwarded-For: the latter is
    // client-supplied and trivially spoofed, which would put a forged address
    // into a record whose only purpose is to be relied on later.
    ipAddress: request.headers.get('cf-connecting-ip'),
    userAgent: request.headers.get('user-agent'),
  };
}

/**
 * The account's compliance standing: any restriction, and verification status.
 * Read by the account banner and the verification settings panel, and computed
 * by the same code the generation gate uses so the two cannot disagree.
 */
export const getComplianceStatusFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const team = await resolveUserTeam(context.user.id);
    const state = await loadComplianceState(context.user.id, team?.teamId);
    return {
      ...summarizeCompliance(state),
      policy: getVerificationPolicy(),
    };
  });

/**
 * Begin an identity check.
 *
 * Opens the `pending` row first, then asks the adapter what the user should do
 * next — in that order, because the row's id is the reference the provider
 * quotes in its callback. Returns whatever the adapter decided: a redirect to a
 * hosted flow, or "submitted for review".
 */
export const startIdentityVerificationFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .handler(async ({ context }) => {
    const adapter = resolveVerificationAdapter();

    const existing =
      await context.scopedDb.compliance.verifications.listForUser();
    const alreadyPending = existing.find((row) => row.status === 'pending');
    if (alreadyPending) {
      // Re-entering the flow is normal (the user closed the tab, the redirect
      // failed). Reuse the open attempt rather than stacking pending rows, so
      // the reviewer queue shows one item per person.
      return {
        verificationId: alreadyPending.id,
        next: adapter.start({
          verificationId: alreadyPending.id,
          appUrl: getServerAppUrl(getRequest()),
        }),
        manualDecision: adapter.manualDecision,
      };
    }

    const { ipAddress, userAgent } = requestContext();
    const row = await context.scopedDb.compliance.verifications.start({
      provider: adapter.id,
      method: adapter.method,
      ipAddress,
      userAgent,
    });

    return {
      verificationId: row.id,
      next: adapter.start({
        verificationId: row.id,
        appUrl: getServerAppUrl(getRequest()),
      }),
      manualDecision: adapter.manualDecision,
    };
  });

/** Verification attempts on the acting account, newest first. */
export const listMyVerificationsFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .handler(async ({ context }) => {
    const rows = await context.scopedDb.compliance.verifications.listForUser();
    // Never return `subjectNameSha256` to the client. It is an equality handle
    // for internal duplicate detection, and shipping it to the browser would
    // make one user's identity hash comparable by anyone who can read a
    // response body.
    return rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      status: row.status,
      method: row.method,
      verifiedAt: row.verifiedAt,
      expiresAt: row.expiresAt,
      rejectionReason: row.rejectionReason,
      createdAt: row.createdAt,
    }));
  });

/**
 * Record a rights attestation for an upload.
 *
 * The client sends what it was shown (`statementVersion`) and what the user
 * declared; the hash is computed server-side from our own copy of the text, so
 * a client cannot attest to wording it invented. A version the server does not
 * recognize is rejected rather than stored.
 */
export const recordUploadAttestationFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        subjectType: z.enum(ATTESTATION_SUBJECT_TYPES),
        subjectId: z.string().min(1).max(200),
        statementVersion: z.string().min(1).max(60),
        depictsRealPerson: z.boolean(),
        authorizationBasis: z.string().max(500).optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const statement = statementFor({
      subjectType: data.subjectType,
      depictsRealPerson: data.depictsRealPerson,
    });

    if (statement.version !== data.statementVersion) {
      // The client rendered different wording than the rule says applies —
      // usually a stale tab after a statement version bump. Refuse: an
      // attestation to the wrong statement is not evidence of anything.
      throw new ValidationError(
        `Attestation version mismatch: expected ${statement.version}`
      );
    }
    if (statement.requiresBasis && !data.authorizationBasis?.trim()) {
      throw new AttestationRequiredError(
        'An authorization basis is required for likeness uploads'
      );
    }

    const { ipAddress, userAgent } = requestContext();
    const row = await context.scopedDb.compliance.attestations.record({
      subjectType: data.subjectType,
      subjectId: data.subjectId,
      statementVersion: statement.version,
      statementSha256: await statementHash(statement),
      depictsRealPerson: data.depictsRealPerson,
      authorizationBasis: data.authorizationBasis?.trim() ?? null,
      ipAddress,
      userAgent,
    });

    return { id: row.id, attestedAt: row.attestedAt };
  });
