import { describe, expect, it } from 'vitest';
import {
  getVerificationPolicy,
  requiresVerifiedIdentity,
  resolveVerificationState,
  type VerificationRow,
} from './identity-verification';
import { isRestrictedModel } from './restricted-models';
import { hashSubjectName, normalizeSubjectName, sha256Hex } from './hash';
import {
  attestationMatchesShippedText,
  PORTRAIT_RIGHTS_V1,
  ASSET_RIGHTS_V1,
  statementFor,
  statementHash,
} from './attestations';
import {
  formatReportReference,
  formatTraceId,
  parseTraceId,
} from './provenance';

const NOW = new Date('2026-08-12T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function row(overrides: Partial<VerificationRow> = {}): VerificationRow {
  return {
    id: 'idv_1',
    status: 'verified',
    provider: 'manual_review',
    method: 'document_and_liveness',
    verifiedAt: new Date(NOW.getTime() - DAY),
    expiresAt: null,
    ...overrides,
  };
}

describe('resolveVerificationState', () => {
  it('reports none for an account that never tried', () => {
    expect(resolveVerificationState([], NOW)).toMatchObject({
      verified: false,
      status: 'none',
      pending: false,
    });
  });

  it('reports verified for a live check', () => {
    const state = resolveVerificationState([row()], NOW);
    expect(state.verified).toBe(true);
    expect(state.pending).toBe(false);
    expect(state.current?.id).toBe('idv_1');
  });

  it('treats a lapsed verification as expired even though the row still says verified', () => {
    // Nothing sweeps this table on a timer, so expiry has to be evaluated at
    // read time or a lapsed check would keep passing the gate indefinitely.
    const state = resolveVerificationState(
      [row({ expiresAt: new Date(NOW.getTime() - 1) })],
      NOW
    );
    expect(state.verified).toBe(false);
    expect(state.status).toBe('expired');
  });

  it('reports pending while a submitted check awaits an answer', () => {
    expect(
      resolveVerificationState(
        [row({ status: 'pending', verifiedAt: null })],
        NOW
      )
    ).toMatchObject({ verified: false, status: 'pending', pending: true });
  });

  it('prefers a live verification over an older rejection', () => {
    const state = resolveVerificationState(
      [row({ id: 'good' }), row({ id: 'old', status: 'rejected' })],
      NOW
    );
    expect(state.verified).toBe(true);
    expect(state.current?.id).toBe('good');
  });

  it('surfaces rejection ahead of revoked and expired so the UI can be specific', () => {
    const state = resolveVerificationState(
      [
        row({ id: 'a', status: 'expired' }),
        row({ id: 'b', status: 'rejected' }),
      ],
      NOW
    );
    expect(state.status).toBe('rejected');
  });

  it('reports revoked when that is all there is', () => {
    expect(
      resolveVerificationState([row({ status: 'revoked' })], NOW).status
    ).toBe('revoked');
  });
});

describe('requiresVerifiedIdentity', () => {
  it('requires nothing when the policy is disabled', () => {
    expect(
      requiresVerifiedIdentity({ kind: 'portrait_upload' }, 'disabled')
    ).toBe(false);
    expect(
      requiresVerifiedIdentity(
        { kind: 'generation', provider: 'modelark', model: 'seedance-2.0' },
        'disabled'
      )
    ).toBe(false);
  });

  it('always requires verification for a likeness upload once enabled', () => {
    expect(
      requiresVerifiedIdentity(
        { kind: 'portrait_upload' },
        'portrait_and_restricted'
      )
    ).toBe(true);
  });

  it('requires verification for a restricted-provider model', () => {
    expect(
      requiresVerifiedIdentity(
        { kind: 'generation', provider: 'modelark', model: 'seedance-2.0' },
        'portrait_and_restricted'
      )
    ).toBe(true);
  });

  it('does not require verification for ordinary fal generation', () => {
    // fal is the platform operator under its own terms, so our real-name
    // obligation does not attach — demanding documents here would be gratuitous.
    expect(
      requiresVerifiedIdentity(
        { kind: 'generation', provider: 'fal', model: 'fal-ai/flux-1/dev' },
        'portrait_and_restricted'
      )
    ).toBe(false);
  });

  it('requires verification for every generation under the strictest policy', () => {
    expect(
      requiresVerifiedIdentity(
        { kind: 'generation', provider: 'fal', model: 'fal-ai/flux-1/dev' },
        'all_generation'
      )
    ).toBe(true);
  });
});

describe('isRestrictedModel', () => {
  it('matches a restricted provider regardless of model', () => {
    expect(isRestrictedModel({ provider: 'modelark', model: 'anything' })).toBe(
      true
    );
    expect(isRestrictedModel({ provider: 'MODELARK' })).toBe(true);
  });

  it('does not match unknown providers, so a typo cannot gate the catalogue', () => {
    expect(isRestrictedModel({ provider: 'fal', model: 'seedance' })).toBe(
      false
    );
    expect(isRestrictedModel({})).toBe(false);
  });
});

describe('name hashing', () => {
  it('normalizes case, spacing, and combining marks', () => {
    expect(normalizeSubjectName('  Ada   LOVELACE ')).toBe('ada lovelace');
    // Same name, composed vs decomposed — must not read as two people.
    expect(normalizeSubjectName('José')).toBe(normalizeSubjectName('José'));
  });

  it('produces equal hashes for equivalent names and different for different', async () => {
    const a = await hashSubjectName('Ada Lovelace', 'salt');
    const b = await hashSubjectName('  ada lovelace ', 'salt');
    const c = await hashSubjectName('Alan Turing', 'salt');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('returns null without a salt rather than falling back to an unsalted digest', async () => {
    // An unsalted hash of a real name is reversible by enumeration — losing
    // duplicate detection is the correct trade.
    expect(await hashSubjectName('Ada Lovelace', undefined)).toBeNull();
    expect(await hashSubjectName('Ada Lovelace', '   ')).toBeNull();
  });

  it('salts the digest, so the same name differs across deployments', async () => {
    expect(await hashSubjectName('Ada Lovelace', 'salt-a')).not.toBe(
      await hashSubjectName('Ada Lovelace', 'salt-b')
    );
  });

  it('returns null for a name that normalizes to nothing', async () => {
    expect(await hashSubjectName('   ', 'salt')).toBeNull();
  });
});

describe('attestations', () => {
  it('applies the portrait statement when a real person is depicted', () => {
    expect(
      statementFor({ subjectType: 'talent', depictsRealPerson: true }).version
    ).toBe(PORTRAIT_RIGHTS_V1.version);
    // Driven by what is depicted, not by which table it lands in: a
    // sequence_element can be a headshot and a talent can be synthetic.
    expect(
      statementFor({
        subjectType: 'sequence_element',
        depictsRealPerson: true,
      }).version
    ).toBe(PORTRAIT_RIGHTS_V1.version);
    expect(
      statementFor({ subjectType: 'talent', depictsRealPerson: false }).version
    ).toBe(ASSET_RIGHTS_V1.version);
  });

  it('demands an authorization basis for likeness uploads only', () => {
    expect(PORTRAIT_RIGHTS_V1.requiresBasis).toBe(true);
    expect(ASSET_RIGHTS_V1.requiresBasis).toBe(false);
  });

  it('hashes the statement text verbatim', async () => {
    expect(await statementHash(PORTRAIT_RIGHTS_V1)).toBe(
      await sha256Hex(PORTRAIT_RIGHTS_V1.text)
    );
  });

  it('confirms a stored attestation still matches the shipped wording', async () => {
    const stored = {
      statementVersion: PORTRAIT_RIGHTS_V1.version,
      statementSha256: await statementHash(PORTRAIT_RIGHTS_V1),
    };
    expect(await attestationMatchesShippedText(stored)).toBe(true);
  });

  it('detects wording that was edited in place after being agreed to', async () => {
    // This is the failure the versioning rule exists to prevent: editing v1's
    // text silently invalidates every stored v1 hash.
    expect(
      await attestationMatchesShippedText({
        statementVersion: PORTRAIT_RIGHTS_V1.version,
        statementSha256: await sha256Hex('some older wording'),
      })
    ).toBe(false);
  });

  it('reports a mismatch for an unknown version', async () => {
    expect(
      await attestationMatchesShippedText({
        statementVersion: 'portrait-rights-v99',
        statementSha256: 'deadbeef',
      })
    ).toBe(false);
  });

  it('covers the substance a provider ownership declaration requires', () => {
    // The asset statement must be at least as strong as what we warrant
    // upstream, including the "not similar to a real person" clause that makes a
    // synthetic avatar distinguishable from an unlicensed likeness.
    expect(ASSET_RIGHTS_V1.text).toContain(
      'similar to the likeness of any real person'
    );
    expect(PORTRAIT_RIGHTS_V1.text).toContain(
      'specifically permits AI generation'
    );
  });
});

describe('trace ids', () => {
  const ulid = '01JAVQZ8XK9YB2H3M4N5P6Q7R8';

  it('round-trips the prefixed form', () => {
    expect(parseTraceId(formatTraceId(ulid))).toBe(ulid);
  });

  it('accepts what a reporter actually pastes', () => {
    // Retyped out of an email: lowercase, whitespace, prefix dropped.
    expect(parseTraceId(`  os-${ulid.toLowerCase()}  `)).toBe(ulid);
    expect(parseTraceId(ulid)).toBe(ulid);
  });

  it('rejects anything that cannot be a ULID, so it fails as not-found', () => {
    expect(parseTraceId('https://example.com/video.mp4')).toBeNull();
    expect(parseTraceId('OS-nope')).toBeNull();
    expect(parseTraceId('')).toBeNull();
    // ULID's alphabet excludes I, L, O, and U to avoid transcription errors.
    expect(parseTraceId('01JAVQZ8XK9YB2H3M4N5P6Q7RI')).toBeNull();
  });

  it('does not parse a report reference as a provenance id', () => {
    expect(parseTraceId(formatReportReference(ulid))).toBeNull();
  });
});

describe('getVerificationPolicy', () => {
  it('defaults to portrait_and_restricted when unset or unrecognized', () => {
    // Vitest does not load wrangler [env.test] vars. An unrecognized value
    // must fail closed to the default, never to `disabled`.
    expect(getVerificationPolicy()).toBe('portrait_and_restricted');
  });
});
