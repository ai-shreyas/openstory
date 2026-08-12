/**
 * Identity verification provider adapters (#1180).
 *
 * The adapter's job is narrow: get a real-name check performed on a user, and
 * report the outcome. What happens with that outcome — who may generate what —
 * is policy and lives in `./identity-verification`.
 *
 * Three adapters:
 *
 *  - `manual_review` — the user submits, an admin decides in
 *    `/admin/moderation`. Fully implemented and works today. Documents are
 *    exchanged out-of-band and deliberately never stored here.
 *  - `byteplus_rpv` — hands off to BytePlus's hosted Real Person Verification
 *    flow and waits for its callback. The redirect and the callback contract are
 *    implemented; the field names inside the provider's callback payload are the
 *    one thing that must be confirmed against their live docs before enabling —
 *    see `parseProviderCallback`.
 *  - `dev_stub` — resolves instantly, refuses to load outside local dev.
 *
 * Which one is active comes from `IDENTITY_VERIFICATION_PROVIDER`.
 */

import { complianceEnv } from '@/lib/compliance/config';
import type {
  IdentityVerificationMethod,
  IdentityVerificationProvider,
} from '@/lib/db/schema/compliance';
import { ConfigurationError, ValidationError } from '@/lib/errors';

/** What the client should do next after starting a verification. */
type VerificationStart =
  /** Send the user to a provider-hosted flow; the callback completes it. */
  | { kind: 'redirect'; url: string }
  /** Submitted for human review; nothing more for the user to do now. */
  | { kind: 'pending_review' }
  /** Resolved immediately (dev only). */
  | { kind: 'verified' };

export type VerificationAdapter = {
  id: IdentityVerificationProvider;
  /** What a successful check with this provider proves. */
  method: IdentityVerificationMethod;
  /** Whether an admin resolves the outcome by hand. */
  manualDecision: boolean;
  /**
   * Begin a check. `verificationId` is the row already opened as `pending`, and
   * is what the provider's callback must quote back so the answer lands on the
   * right attempt.
   */
  start(input: { verificationId: string; appUrl: string }): VerificationStart;
};

const manualReview: VerificationAdapter = {
  id: 'manual_review',
  // A reviewer looking at a document and a selfie is establishing both a name
  // and that its holder is present, which is what the strongest tier means.
  method: 'document_and_liveness',
  manualDecision: true,
  start: () => ({ kind: 'pending_review' }),
};

const devStub: VerificationAdapter = {
  id: 'dev_stub',
  method: 'document',
  manualDecision: false,
  start: () => ({ kind: 'verified' }),
};

/**
 * BytePlus Real Person Verification, hosted H5 flow.
 *
 * We send the user to the provider with our own `verificationId` as the
 * reference and a return URL; the provider performs document + liveness capture
 * and calls our webhook. Nothing about the user's documents transits our
 * servers, which is the point of using a hosted flow.
 */
function bytePlusRpv(): VerificationAdapter {
  const baseUrl = complianceEnv('BYTEPLUS_RPV_BASE_URL');
  if (!baseUrl) {
    throw new ConfigurationError(
      'IDENTITY_VERIFICATION_PROVIDER=byteplus_rpv requires BYTEPLUS_RPV_BASE_URL'
    );
  }
  if (!complianceEnv('BYTEPLUS_RPV_CALLBACK_SECRET')) {
    // Without a shared secret the callback endpoint would accept a "verified"
    // result from anyone who could guess a verification id — i.e. the identity
    // check would be self-service. Fail to start rather than run open.
    throw new ConfigurationError(
      'IDENTITY_VERIFICATION_PROVIDER=byteplus_rpv requires BYTEPLUS_RPV_CALLBACK_SECRET'
    );
  }

  return {
    id: 'byteplus_rpv',
    method: 'document_and_liveness',
    manualDecision: false,
    start: ({ verificationId, appUrl }) => {
      const url = new URL(baseUrl);
      // Our reference travels as a query param and comes back in the callback.
      url.searchParams.set('reference_id', verificationId);
      url.searchParams.set(
        'redirect_url',
        new URL('/settings/identity', appUrl).toString()
      );
      return { kind: 'redirect', url: url.toString() };
    },
  };
}

/**
 * The active adapter.
 *
 * Defaults to `manual_review`: it is the option that works with no third-party
 * credentials, so a deployment that has enabled the verification policy without
 * wiring a provider still collects and decides checks rather than silently
 * verifying nobody.
 */
export function resolveVerificationAdapter(): VerificationAdapter {
  const configured = complianceEnv('IDENTITY_VERIFICATION_PROVIDER');

  switch (configured) {
    case 'byteplus_rpv':
      return bytePlusRpv();
    case 'dev_stub':
      // `import.meta.env.DEV` is the same build-time gate the dev fixed-OTP
      // bypass uses: only `vite dev` sets it, and every deployed artifact is a
      // build where Vite define-replaces it with `false` and eliminates the
      // branch entirely. A runtime env check could be flipped by a deploy
      // variable; this cannot.
      if (!import.meta.env.DEV) {
        // A stub that verifies everyone is worse than no verification at all,
        // because it produces `verified` rows that look real in an audit.
        throw new ConfigurationError(
          'IDENTITY_VERIFICATION_PROVIDER=dev_stub is not permitted outside local development'
        );
      }
      return devStub;
    case 'manual_review':
    case undefined:
      return manualReview;
    default:
      throw new ConfigurationError(
        `Unknown IDENTITY_VERIFICATION_PROVIDER: ${configured}`
      );
  }
}

/**
 * The outcome a provider callback carries, once validated.
 */
export type ProviderCallbackResult = {
  verificationId: string;
  verified: boolean;
  /** Provider's own id for the check, stored as `providerRef`. */
  providerRef?: string;
  /** Verified legal name — hashed immediately, never stored raw. */
  subjectName?: string;
  subjectCountry?: string;
  rejectionReason?: string;
};

/**
 * Validate and parse a provider callback body.
 *
 * ⚠️ The field names below are the ONE mapping in this feature that has to be
 * confirmed against BytePlus's live callback documentation before
 * `byteplus_rpv` is enabled — everything else in the flow is under our control.
 * They are read defensively (several accepted spellings per field, unknown keys
 * ignored) so a mismatch surfaces as a rejected callback with a clear message
 * rather than as a silently-misparsed "verified".
 *
 * Auth is a shared secret compared in constant time by the route; this function
 * assumes that check already passed and only concerns itself with shape.
 */
export function parseProviderCallback(body: unknown): ProviderCallbackResult {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('Verification callback body must be an object');
  }

  // `Reflect.get` on the narrowed object, so reading a provider's payload needs
  // no assertion about its shape — which is the point, since the shape is the
  // one thing here we have not confirmed.
  const str = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value: unknown = Reflect.get(body, key);
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
  };

  const verificationId = str('reference_id', 'referenceId', 'verification_id');
  if (!verificationId) {
    throw new ValidationError(
      'Verification callback is missing its reference id'
    );
  }

  const status = str('status', 'result', 'verify_result')?.toLowerCase();
  if (!status) {
    throw new ValidationError('Verification callback is missing its status');
  }

  // Allowlist the passing values rather than treating "not failed" as passed:
  // an unrecognized status must never resolve to `verified`.
  const verified = [
    'success',
    'succeeded',
    'passed',
    'verified',
    'true',
  ].includes(status);

  return {
    verificationId,
    verified,
    providerRef: str('verification_id', 'request_id', 'task_id'),
    subjectName: str('name', 'real_name', 'subject_name'),
    subjectCountry: str('country', 'country_code'),
    rejectionReason: verified
      ? undefined
      : (str('reason', 'fail_reason', 'message') ?? `status=${status}`),
  };
}
