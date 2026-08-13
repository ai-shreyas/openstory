import { describe, expect, it } from 'vitest';
import { ValidationError } from '@/lib/errors';
import { parseProviderCallback } from './verification-providers';

describe('parseProviderCallback', () => {
  it('accepts a passing status on the reference_id field', () => {
    expect(
      parseProviderCallback({
        reference_id: '01JAVTESTVERIFICATION000001',
        status: 'verified',
      })
    ).toMatchObject({
      verificationId: '01JAVTESTVERIFICATION000001',
      verified: true,
    });
  });

  it('rejects a failed status without treating it as verified', () => {
    expect(
      parseProviderCallback({
        reference_id: '01JAVTESTVERIFICATION000001',
        status: 'failed',
        reason: 'liveness',
      })
    ).toMatchObject({
      verified: false,
      rejectionReason: 'liveness',
    });
  });

  it('throws on an in-flight or unknown status instead of deciding the row', () => {
    expect(() =>
      parseProviderCallback({
        reference_id: '01JAVTESTVERIFICATION000001',
        status: 'processing',
      })
    ).toThrow(ValidationError);
  });

  it('throws when the reference id is missing', () => {
    expect(() => parseProviderCallback({ status: 'verified' })).toThrow(
      ValidationError
    );
  });

  it('throws when the status is missing', () => {
    expect(() =>
      parseProviderCallback({ reference_id: '01JAVTESTVERIFICATION000001' })
    ).toThrow(ValidationError);
  });

  it('does not reuse verification_id as the provider ref', () => {
    const result = parseProviderCallback({
      verification_id: '01JAVTESTVERIFICATION000001',
      status: 'success',
      request_id: 'prov_99',
    });
    expect(result.verificationId).toBe('01JAVTESTVERIFICATION000001');
    expect(result.providerRef).toBe('prov_99');
  });
});
