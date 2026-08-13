/**
 * Moderation server functions — admin only (#1180).
 *
 * The violation-handling half of the platform-operator obligations: triage
 * reports, trace content back to the account that made it, act, and record what
 * was done. Every function here is behind `systemAdminMiddleware`, so the whole
 * surface is unreachable without an `ADMIN_EMAILS` match.
 */

import { systemAdminMiddleware } from './middleware';
import {
  CONTENT_REPORT_REASONS,
  CONTENT_REPORT_STATUSES,
  ENFORCEMENT_ACTIONS,
  IDENTITY_VERIFICATION_METHODS,
} from '@/lib/db/schema/compliance';
import { hashSubjectName } from '@/lib/compliance/hash';
import { complianceEnv } from '@/lib/compliance/config';
import { parseTraceId } from '@/lib/compliance/provenance';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { ValidationError } from '@/lib/errors';
import { getLogger } from '@/lib/observability/logger';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

const logger = getLogger(['openstory', 'compliance', 'moderation']);

// ============================================================================
// Report queue
// ============================================================================

export const listContentReportsFn = createServerFn({ method: 'GET' })
  .middleware([systemAdminMiddleware])
  .validator(
    zodValidator(
      z.object({
        statuses: z.array(z.enum(CONTENT_REPORT_STATUSES)).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const [reports, counts] = await Promise.all([
      context.adminScopedDb.moderation.listReports(data),
      context.adminScopedDb.moderation.countReportsByStatus(),
    ]);
    return { reports, counts };
  });

export const resolveContentReportFn = createServerFn({ method: 'POST' })
  .middleware([systemAdminMiddleware])
  .validator(
    zodValidator(
      z.object({
        reportId: ulidSchema,
        status: z.enum(['triaged', 'actioned', 'dismissed']),
        resolutionNotes: z.string().max(5000).optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    await context.adminScopedDb.moderation.resolveReport({
      reportId: data.reportId,
      status: data.status,
      handledByUserId: context.user.id,
      resolutionNotes: data.resolutionNotes ?? null,
    });
    logger.info('report {reportId} resolved as {status}', {
      reportId: data.reportId,
      status: data.status,
      handledBy: context.user.id,
    });
    return { ok: true };
  });

/** Attach the resolved owner of the reported content to the report. */
export const attributeContentReportFn = createServerFn({ method: 'POST' })
  .middleware([systemAdminMiddleware])
  .validator(
    zodValidator(
      z.object({
        reportId: ulidSchema,
        subjectTeamId: ulidSchema.optional(),
        subjectUserId: z.string().max(200).optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    await context.adminScopedDb.moderation.attributeReport({
      reportId: data.reportId,
      subjectTeamId: data.subjectTeamId ?? null,
      subjectUserId: data.subjectUserId ?? null,
    });
    return { ok: true };
  });

// ============================================================================
// Trace — "here is a file, who made it?"
// ============================================================================

/**
 * Resolve an asset to the account that produced it.
 *
 * Takes whatever a complainant supplied. A pasted URL is reduced to its R2 key
 * because that is what provenance stores: the same object is reachable through
 * an origin-relative path, the CDN domain, and a signed URL, and matching on the
 * key makes all three resolve.
 */
export const traceContentFn = createServerFn({ method: 'GET' })
  .middleware([systemAdminMiddleware])
  .validator(
    zodValidator(
      z.object({
        /** Trace id (`OS-…`), R2 key, asset URL, content hash, or request id. */
        query: z.string().min(3).max(1000),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const raw = data.query.trim();

    const provenanceId = parseTraceId(raw);
    const storageKey = extractStorageKey(raw);
    const contentSha256 = /^[0-9a-f]{64}$/i.test(raw)
      ? raw.toLowerCase()
      : null;

    const results = await context.adminScopedDb.moderation.findProvenance({
      provenanceId,
      storageKey,
      contentSha256,
      // Anything that isn't recognizably one of the above is still worth trying
      // as a provider request id — fal ids have no fixed shape we can match on.
      providerRequestId:
        provenanceId || storageKey || contentSha256 ? null : raw,
    });

    return { results };
  });

/**
 * Reduce a pasted asset reference to the R2 key provenance stores.
 *
 * Handles the three forms an asset URL takes in this app — an origin-relative
 * `/r2/<key>`, an absolute URL on the app or CDN domain, and a bare key — and
 * returns null for anything else so the caller can fall through to other
 * lookups. Deliberately does not guess: a wrong key silently returns "no
 * provenance found", which reads as "we cannot trace our own content".
 */
function extractStorageKey(input: string): string | null {
  const withoutQuery = input.split('?')[0] ?? input;

  const r2Marker = '/r2/';
  const markerIndex = withoutQuery.indexOf(r2Marker);
  if (markerIndex >= 0) {
    const key = withoutQuery.slice(markerIndex + r2Marker.length);
    return key || null;
  }

  if (
    withoutQuery.startsWith('http://') ||
    withoutQuery.startsWith('https://')
  ) {
    try {
      const path = new URL(withoutQuery).pathname.replace(/^\/+/, '');
      return path || null;
    } catch {
      return null;
    }
  }

  // A bare key: has a path separator and an extension, no scheme. Distinguishes
  // `sequences/abc/shot-1.mp4` from a trace id or a free-text search.
  if (withoutQuery.includes('/') && /\.[a-z0-9]{2,5}$/i.test(withoutQuery)) {
    return withoutQuery;
  }
  return null;
}

/** Everything an account generated — evidence for an enforcement decision. */
export const listTeamProvenanceFn = createServerFn({ method: 'GET' })
  .middleware([systemAdminMiddleware])
  .validator(
    zodValidator(
      z.object({
        teamId: ulidSchema,
        limit: z.number().int().min(1).max(200).optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const [provenance, attestations] = await Promise.all([
      context.adminScopedDb.moderation.listProvenanceForTeam(data.teamId, {
        limit: data.limit,
      }),
      context.adminScopedDb.moderation.listAttestationsForTeam(data.teamId, {
        limit: data.limit,
      }),
    ]);
    return { provenance, attestations };
  });

// ============================================================================
// Enforcement
// ============================================================================

export const applyEnforcementFn = createServerFn({ method: 'POST' })
  .middleware([systemAdminMiddleware])
  .validator(
    zodValidator(
      z.object({
        subjectUserId: z.string().max(200).optional(),
        subjectTeamId: ulidSchema.optional(),
        action: z.enum(ENFORCEMENT_ACTIONS),
        reason: z.enum(CONTENT_REPORT_REASONS),
        notes: z.string().max(5000).optional(),
        reportId: ulidSchema.optional(),
        /** Timed suspension, in days. Omit for indefinite. */
        expiresInDays: z.number().int().min(1).max(3650).optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    if (!data.subjectUserId && !data.subjectTeamId) {
      throw new ValidationError(
        'An enforcement action needs a subject user or team'
      );
    }

    const expiresAt = data.expiresInDays
      ? new Date(Date.now() + data.expiresInDays * 24 * 60 * 60 * 1000)
      : null;

    const action = await context.adminScopedDb.moderation.applyEnforcement({
      subjectUserId: data.subjectUserId ?? null,
      subjectTeamId: data.subjectTeamId ?? null,
      action: data.action,
      reason: data.reason,
      notes: data.notes ?? null,
      reportId: data.reportId ?? null,
      actorUserId: context.user.id,
      expiresAt,
    });

    // At `warn`, with the actor: enforcement is the most consequential thing
    // this admin surface can do, and it should be reconstructable from logs
    // alone even if the table is later disputed.
    logger.warn('enforcement applied: {action} for {reason}', {
      enforcementId: action.id,
      action: data.action,
      reason: data.reason,
      subjectUserId: data.subjectUserId,
      subjectTeamId: data.subjectTeamId,
      actorUserId: context.user.id,
      expiresAt,
    });

    return action;
  });

export const revokeEnforcementFn = createServerFn({ method: 'POST' })
  .middleware([systemAdminMiddleware])
  .validator(
    zodValidator(
      z.object({
        enforcementId: ulidSchema,
        revokedReason: z.string().max(500).optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    await context.adminScopedDb.moderation.revokeEnforcement({
      enforcementId: data.enforcementId,
      revokedByUserId: context.user.id,
      revokedReason: data.revokedReason ?? null,
    });
    logger.warn('enforcement {enforcementId} revoked', {
      enforcementId: data.enforcementId,
      actorUserId: context.user.id,
    });
    return { ok: true };
  });

export const listEnforcementFn = createServerFn({ method: 'GET' })
  .middleware([systemAdminMiddleware])
  .validator(
    zodValidator(
      z.object({
        subjectUserId: z.string().max(200).optional(),
        subjectTeamId: ulidSchema.optional(),
        limit: z.number().int().min(1).max(200).optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    return context.adminScopedDb.moderation.listEnforcement(data);
  });

// ============================================================================
// Identity verification review
// ============================================================================

export const listPendingVerificationsFn = createServerFn({ method: 'GET' })
  .middleware([systemAdminMiddleware])
  .handler(async ({ context }) => {
    const rows =
      await context.adminScopedDb.moderation.listPendingVerifications();
    // Strip the identity hash before it reaches a browser (see the note in
    // listMyVerificationsFn).
    return rows.map(({ subjectNameSha256: _hash, ...row }) => row);
  });

/**
 * Decide a manual-review verification.
 *
 * The reviewer types the legal name they saw on the document; it is hashed here
 * and the plaintext is discarded with the request. That is the whole point of
 * the salted hash — duplicate detection without our database ever holding a
 * name — so the name must not be stored, logged, or echoed back.
 */
export const decideVerificationFn = createServerFn({ method: 'POST' })
  .middleware([systemAdminMiddleware])
  .validator(
    zodValidator(
      z.object({
        verificationId: ulidSchema,
        verified: z.boolean(),
        method: z.enum(IDENTITY_VERIFICATION_METHODS).optional(),
        subjectName: z.string().max(300).optional(),
        subjectCountry: z.string().length(2).optional(),
        rejectionReason: z.string().max(500).optional(),
        expiresInDays: z.number().int().min(1).max(3650).optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const subjectNameSha256 = data.subjectName
      ? await hashSubjectName(
          data.subjectName,
          complianceEnv('IDENTITY_HASH_SALT')
        )
      : null;

    await context.adminScopedDb.moderation.decideVerification({
      verificationId: data.verificationId,
      verified: data.verified,
      method: data.method ?? null,
      subjectNameSha256,
      subjectCountry: data.subjectCountry?.toUpperCase() ?? null,
      rejectionReason: data.rejectionReason ?? null,
      expiresAt: data.expiresInDays
        ? new Date(Date.now() + data.expiresInDays * 24 * 60 * 60 * 1000)
        : null,
    });

    // Duplicate-identity signal, surfaced at decision time rather than in a
    // nightly sweep — the moment it is useful is while the reviewer is still
    // looking at the account.
    const sharedWith = subjectNameSha256
      ? await context.adminScopedDb.moderation.findSharedIdentities(
          subjectNameSha256
        )
      : [];

    logger.info('verification {verificationId} decided: {verified}', {
      verificationId: data.verificationId,
      verified: data.verified,
      reviewerId: context.user.id,
      sharedAccountCount: sharedWith.length,
    });

    return {
      ok: true,
      /**
       * How many OTHER accounts this legal identity has verified. The query
       * includes the row just decided, so distinct users minus one; a user with
       * several verified attempts must not count as several accounts, hence the
       * Set.
       */
      sharedAccounts: Math.max(
        0,
        new Set(sharedWith.map((row) => row.userId)).size - 1
      ),
    };
  });

export const revokeVerificationFn = createServerFn({ method: 'POST' })
  .middleware([systemAdminMiddleware])
  .validator(
    zodValidator(
      z.object({
        verificationId: ulidSchema,
        revokedReason: z.string().max(500).optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    await context.adminScopedDb.moderation.revokeVerification({
      verificationId: data.verificationId,
      revokedByUserId: context.user.id,
      revokedReason: data.revokedReason ?? null,
    });
    logger.warn('verification {verificationId} revoked', {
      verificationId: data.verificationId,
      actorUserId: context.user.id,
    });
    return { ok: true };
  });
