/**
 * The generation gate (#1180).
 *
 * One call, made from every generation entry point right beside the credit
 * preflight: may this account generate this thing right now? Two ways the answer
 * is no — a live enforcement action, or a missing identity verification the
 * model's terms require — and they raise different errors because they have
 * opposite remedies (appeal vs. complete a step).
 *
 * Placed beside `requireCredits` rather than inside it: the credit preflight is
 * also handed the narrowed workflow read surface, and conflating "can they pay"
 * with "are they allowed" would make both harder to reason about. Pairing is
 * enforced by `generation-gate.wiring.test.ts`, which fails if a server function
 * calls `requireCredits` without also calling a gate — the failure mode being
 * guarded against is a new generation endpoint that quietly skips compliance.
 */

import { loadComplianceRecords } from '@/lib/db/scoped';
import {
  assertCanGenerate,
  resolveEnforcementState,
  restrictionNotice,
  type EnforcementState,
} from '@/lib/compliance/enforcement';
import {
  requiresVerifiedIdentity,
  resolveVerificationState,
  verificationRequirementReason,
  type GatedAction,
  type VerificationState,
} from '@/lib/compliance/identity-verification';
import { restrictedModelRule } from '@/lib/compliance/restricted-models';
import { IdentityVerificationRequiredError } from '@/lib/errors';

export type ComplianceState = {
  enforcement: EnforcementState;
  verification: VerificationState;
};

/**
 * Load and resolve both halves of an account's compliance standing.
 *
 * Exposed on its own because the UI needs the same answer the gate uses — a
 * banner explaining a restriction, and a verification panel showing status,
 * should never disagree with what the server will actually allow.
 */
export async function loadComplianceState(
  userId: string,
  teamId?: string | null,
  now: Date = new Date()
): Promise<ComplianceState> {
  const { enforcement, verifications } = await loadComplianceRecords(
    userId,
    teamId
  );
  return {
    enforcement: resolveEnforcementState(enforcement, now),
    verification: resolveVerificationState(verifications, now),
  };
}

/**
 * Throw unless the account may run this generation.
 *
 * Checks enforcement first: a suspended account should be told it is suspended,
 * not sent off to verify its identity for a model it will not be allowed to use
 * either way.
 */
export async function requireGenerationAllowed(opts: {
  userId: string;
  teamId: string;
  /** Provider the generation will run against, e.g. `fal`, `modelark`. */
  provider?: string;
  /** Model / endpoint id, for the restricted-model check. */
  model?: string;
}): Promise<void> {
  const state = await loadComplianceState(opts.userId, opts.teamId);
  assertCanGenerate(state.enforcement);

  const action: GatedAction = {
    kind: 'generation',
    provider: opts.provider,
    model: opts.model,
  };
  assertVerified(state, action, {
    provider: opts.provider,
    model: opts.model,
  });
}

/**
 * Throw unless the account may upload an image depicting a real person.
 *
 * The portrait path always requires verification when the policy is enabled at
 * all: a likeness upload is the one action where knowing who the uploader is
 * carries the whole weight of the portrait-rights regime.
 */
export async function requirePortraitUploadAllowed(opts: {
  userId: string;
  teamId: string;
}): Promise<void> {
  const state = await loadComplianceState(opts.userId, opts.teamId);
  assertCanGenerate(state.enforcement);
  assertVerified(state, { kind: 'portrait_upload' }, {});
}

function assertVerified(
  state: ComplianceState,
  action: GatedAction,
  context: { provider?: string; model?: string }
): void {
  if (!requiresVerifiedIdentity(action)) return;
  if (state.verification.verified) return;

  throw new IdentityVerificationRequiredError(
    verificationRequirementReason(action),
    {
      verificationStatus: state.verification.status,
      // `pending` is the difference between "go and do this" and "wait" — the
      // client shows a different panel for each, so the gate has to say which.
      pending: state.verification.pending,
      provider: context.provider,
      model: context.model,
      requiredBy: restrictedModelRule(context)?.why,
      verifyPath: '/settings/identity',
    }
  );
}

/**
 * Summary for the client: what is restricted, and what the user can do about
 * it. Returned by `getComplianceStatusFn` and rendered by the account banner.
 */
export function summarizeCompliance(state: ComplianceState) {
  return {
    canGenerate: state.enforcement.canGenerate,
    canWrite: state.enforcement.canWrite,
    canAccess: state.enforcement.canAccess,
    restrictionNotice: restrictionNotice(state.enforcement),
    verificationStatus: state.verification.status,
    verified: state.verification.verified,
    verificationPending: state.verification.pending,
  };
}
