import { describe, expect, it } from 'vitest';
import { postAuthRedirect } from './post-auth-redirect';

describe('postAuthRedirect', () => {
  it('keeps the composer path', () => {
    expect(postAuthRedirect('/', false)).toBe('/');
    expect(postAuthRedirect('/?style=noir', true)).toBe('/?style=noir');
    expect(postAuthRedirect('/sequences/new', true)).toBe('/sequences/new');
  });

  it('sends a pending enhance/generate away from the empty sequences list', () => {
    expect(postAuthRedirect('/sequences', true)).toBe('/');
    expect(postAuthRedirect('/sequences/', true)).toBe('/');
  });

  it('leaves the sequences list alone when there is no pending intent', () => {
    expect(postAuthRedirect('/sequences', false)).toBe('/sequences');
  });
});
