/**
 * Real-name identity verification — policy and state resolution (#1180).
 *
 * Two separable questions, both answered here:
 *
 *  1. **Does this account have a current verified identity?**
 *     `resolveVerificationState` over `identity_verifications` rows. Pure.
 *  2. **Does this particular action require one?**
 *     `requiresVerifiedIdentity`, driven by the configured policy plus the
 *     restricted-model registry.
 *
 * The provider adapters (who actually checks the document) live in
 * `./verification-providers`. This module never talks to a provider, so the
 * policy can be tested without one.
 */

import { complianceEnv } from '@/lib/compliance/config';
import type {
  IdentityVerification,
  IdentityVerificationStatus,
} from '@/lib/db/schema/compliance';
import { isRestrictedModel } from '@/lib/compliance/restricted-models';

/**
 * The subset of a verification row that decides current state. Structural so
 * callers can pass a narrow select and tests can pass literals.
 */
export type VerificationRow = Pick<
  IdentityVerification,
  'id' | 'status' | 'provider' | 'method' | 'verifiedAt' | 'expiresAt'
>;

export type VerificationState = {
  /** Is there a verification in force right now? */
  verified: boolean;
  /** Best current status across attempts — what the UI shows. */
  status: IdentityVerificationStatus | 'none';
  /** The row that establishes `verified`, when one does. */
  current: VerificationRow | null;
  /** True when a submitted check is awaiting a provider or reviewer answer. */
  pending: boolean;
};

/**
 * Resolve every verification attempt on an account into one state.
 *
 * A verification counts as in force when it is `verified`, not revoked (which
 * is its own status), and either has no expiry or has not reached it. Expiry is
 * evaluated here rather than trusted from the stored status, because nothing
 * sweeps the table on a timer — a row that lapsed at midnight would otherwise
 * still read `verified` until something happened to touch it.
 */
export function resolveVerificationState(
  rows: readonly VerificationRow[],
  now: Date = new Date()
): VerificationState {
  const current =
    rows.find(
      (row) =>
        row.status === 'verified' &&
        (!row.expiresAt || row.expiresAt.getTime() > now.getTime())
    ) ?? null;

  if (current) {
    return {
      verified: true,
      status: 'verified',
      current,
      pending: false,
    };
  }

  const pending = rows.some((row) => row.status === 'pending');
  if (pending) {
    return { verified: false, status: 'pending', current: null, pending: true };
  }

  // No live and no in-flight check: report the most informative terminal
  // status we have, so the UI can say "your check was rejected" rather than
  // "unverified" and send the user somewhere useful.
  const terminal =
    rows.find((row) => row.status === 'rejected') ??
    rows.find((row) => row.status === 'revoked') ??
    rows.find((row) => row.status === 'expired') ??
    // A `verified` row that fell through the `current` check above has expired
    // in fact even if its stored status has not caught up.
    rows.find((row) => row.status === 'verified');

  if (!terminal) {
    return { verified: false, status: 'none', current: null, pending: false };
  }

  return {
    verified: false,
    status: terminal.status === 'verified' ? 'expired' : terminal.status,
    current: null,
    pending: false,
  };
}

// ============================================================================
// Policy — when verification is required
// ============================================================================

/**
 * How strict the platform is about real-name authentication.
 *
 *  - `disabled` — no action requires verification. For self-hosted deploys and
 *    single-tenant internal use, where there are no external end users to
 *    verify and the obligation does not arise.
 *  - `portrait_and_restricted` (default) — verification is required to upload a
 *    real person's likeness, and to use models whose provider agreement
 *    requires end-user real-name authentication. This is the proportionate
 *    setting: it gates the two things that actually carry the obligation
 *    without demanding identity documents from someone making a cartoon.
 *  - `all_generation` — every generation requires a verified identity. For
 *    deployments in jurisdictions that mandate it platform-wide.
 */
const VERIFICATION_POLICIES = [
  'disabled',
  'portrait_and_restricted',
  'all_generation',
] as const;
export type VerificationPolicy = (typeof VERIFICATION_POLICIES)[number];

const DEFAULT_VERIFICATION_POLICY: VerificationPolicy =
  'portrait_and_restricted';

/**
 * Active policy, from `IDENTITY_VERIFICATION_POLICY`.
 *
 * An unrecognized value falls back to the default rather than throwing: a typo
 * in a deploy variable should not take generation down, and the default is the
 * safe direction to fail (it requires more, not less).
 */
export function getVerificationPolicy(): VerificationPolicy {
  const raw = complianceEnv('IDENTITY_VERIFICATION_POLICY');
  const match = VERIFICATION_POLICIES.find((policy) => policy === raw);
  return match ?? DEFAULT_VERIFICATION_POLICY;
}

/** What the caller is about to do, for the policy check. */
export type GatedAction =
  | { kind: 'generation'; provider?: string; model?: string }
  | { kind: 'portrait_upload' };

/**
 * Does this action require a verified real-name identity under the active
 * policy?
 */
export function requiresVerifiedIdentity(
  action: GatedAction,
  policy: VerificationPolicy = getVerificationPolicy()
): boolean {
  if (policy === 'disabled') return false;
  if (action.kind === 'portrait_upload') return true;
  if (policy === 'all_generation') return true;
  return isRestrictedModel({
    provider: action.provider,
    model: action.model,
  });
}

/**
 * Why verification is being asked for, in words the user can act on. Kept next
 * to the policy so the explanation cannot drift from the rule.
 */
export function verificationRequirementReason(action: GatedAction): string {
  if (action.kind === 'portrait_upload') {
    return 'Uploading a real person’s likeness requires a verified identity on this account.';
  }
  return 'This model is provided under terms that require a verified identity for the account using it.';
}
