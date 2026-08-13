/**
 * Identity verification provider callback (#1180).
 *
 * A hosted real-name check (BytePlus RPV and every provider of that shape)
 * reports its outcome by calling us back, because the user's documents never
 * touch our servers. This route is that endpoint.
 *
 * It is unauthenticated in the session sense — the caller is a provider, not a
 * user — so the shared secret is the ONLY thing standing between the internet
 * and a self-service "mark me verified" endpoint. Hence: constant-time compare,
 * fail closed when unconfigured, and never trust a user id from the body (the
 * verification row's own id is the reference, and the row already knows whose
 * it is).
 */

import { complianceEnv } from '@/lib/compliance/config';
import { hashSubjectName } from '@/lib/compliance/hash';
import { parseProviderCallback } from '@/lib/compliance/verification-providers';
import { createSystemAdminScopedDb } from '@/lib/db/scoped';
import { handleApiError } from '@/lib/errors';
import { getLogger } from '@/lib/observability/logger';
import { createFileRoute } from '@tanstack/react-router';
import { json } from '@tanstack/react-start';

const logger = getLogger(['openstory', 'compliance', 'verification-callback']);

/**
 * Constant-time string compare.
 *
 * `===` on secrets leaks length and prefix through timing. The difference is
 * small over the internet but free to avoid, and this is the one comparison in
 * the feature whose failure grants identity verification to a stranger.
 */
function secretsMatch(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let mismatch = 0;
  for (let index = 0; index < provided.length; index += 1) {
    mismatch |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return mismatch === 0;
}

export const Route = createFileRoute('/api/compliance/verification-callback')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const expected = complianceEnv('BYTEPLUS_RPV_CALLBACK_SECRET');
          if (!expected) {
            // Unconfigured means no provider should be calling. Refusing beats
            // accepting: a 503 here is a misconfiguration, whereas accepting
            // would be an open verification endpoint.
            logger.error(
              'verification callback received with no callback secret configured'
            );
            return json(
              {
                error: {
                  code: 'NOT_CONFIGURED',
                  message: 'Verification callbacks are not configured',
                },
              },
              { status: 503 }
            );
          }

          const provided =
            request.headers.get('x-callback-secret') ??
            request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
            '';

          if (!secretsMatch(provided, expected)) {
            logger.warn('verification callback rejected: bad secret');
            return json(
              {
                error: {
                  code: 'UNAUTHORIZED',
                  message: 'Invalid callback secret',
                },
              },
              { status: 401 }
            );
          }

          const result = parseProviderCallback(await request.json());

          // The moderation surface owns these writes: the decision is not being
          // made by a team-scoped caller, and the row belongs to whichever user
          // opened it.
          const { moderation } = createSystemAdminScopedDb();

          const subjectNameSha256 = result.subjectName
            ? await hashSubjectName(
                result.subjectName,
                complianceEnv('IDENTITY_HASH_SALT')
              )
            : null;

          await moderation.decideVerification({
            verificationId: result.verificationId,
            verified: result.verified,
            method: 'document_and_liveness',
            subjectNameSha256,
            subjectCountry: result.subjectCountry ?? null,
            rejectionReason: result.rejectionReason ?? null,
            providerRef: result.providerRef ?? null,
          });

          // No name, no document data, no raw body — only the outcome.
          logger.info(
            'verification {verificationId} resolved by provider: {verified}',
            {
              verificationId: result.verificationId,
              verified: result.verified,
            }
          );

          return json({ ok: true });
        } catch (error) {
          const handled = handleApiError(error);
          return json(
            { success: false, error: handled.toJSON() },
            { status: handled.statusCode }
          );
        }
      },
    },
  },
});
