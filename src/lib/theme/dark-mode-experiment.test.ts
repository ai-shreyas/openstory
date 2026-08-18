import { describe, expect, it } from 'vitest';
import {
  DARK_MODE_BOOT_SCRIPT,
  DARK_MODE_DEFAULT_FLAG,
  DARK_MODE_OVERRIDE_QUERY,
  DARK_MODE_OVERRIDE_STORAGE_KEY,
  DARK_MODE_VARIANT_COOKIE,
  assignmentFromCookies,
  darkModeFeatureProperties,
  parseDarkModeVariant,
  readCookieFromHeader,
  readDarkModeOverride,
  shouldEvaluateDarkModeExperimentFromHost,
  shouldForceDark,
} from './dark-mode-experiment';

describe('parseDarkModeVariant', () => {
  it('accepts control and test', () => {
    expect(parseDarkModeVariant('control')).toBe('control');
    expect(parseDarkModeVariant('test')).toBe('test');
  });

  it('rejects everything else', () => {
    expect(parseDarkModeVariant(true)).toBeNull();
    expect(parseDarkModeVariant(false)).toBeNull();
    expect(parseDarkModeVariant('dark')).toBeNull();
    expect(parseDarkModeVariant(undefined)).toBeNull();
    expect(parseDarkModeVariant(null)).toBeNull();
  });
});

describe('shouldForceDark', () => {
  it('is true only for the test variant', () => {
    expect(shouldForceDark('test')).toBe(true);
    expect(shouldForceDark('control')).toBe(false);
    expect(shouldForceDark(undefined)).toBe(false);
  });
});

describe('readCookieFromHeader', () => {
  it('reads a named cookie and decodes it', () => {
    const header = `${DARK_MODE_VARIANT_COOKIE}=test; other=1`;
    expect(readCookieFromHeader(header, DARK_MODE_VARIANT_COOKIE)).toBe('test');
  });

  it('returns undefined when the cookie is missing', () => {
    expect(
      readCookieFromHeader('a=b', DARK_MODE_VARIANT_COOKIE)
    ).toBeUndefined();
  });
});

describe('assignmentFromCookies', () => {
  it('parses a sticky assignment', () => {
    expect(
      assignmentFromCookies({ variant: 'test', distinctId: 'anon_1' })
    ).toEqual({ variant: 'test', distinctId: 'anon_1' });
  });

  it('drops blank distinct ids and unknown variants', () => {
    expect(
      assignmentFromCookies({ variant: 'nope', distinctId: '  ' })
    ).toEqual({ variant: null, distinctId: null });
  });
});

describe('darkModeFeatureProperties', () => {
  it('stamps the PostHog feature property used by experiments', () => {
    expect(darkModeFeatureProperties('test')).toEqual({
      [`$feature/${DARK_MODE_DEFAULT_FLAG}`]: 'test',
    });
    expect(darkModeFeatureProperties(null)).toEqual({});
  });
});

describe('shouldEvaluateDarkModeExperimentFromHost', () => {
  it('skips local, LAN, and PR-preview hosts', () => {
    expect(shouldEvaluateDarkModeExperimentFromHost('localhost')).toBe(false);
    expect(shouldEvaluateDarkModeExperimentFromHost('127.0.0.1')).toBe(false);
    expect(shouldEvaluateDarkModeExperimentFromHost('192.168.1.4')).toBe(false);
    expect(
      shouldEvaluateDarkModeExperimentFromHost('openstory-pr-1186.workers.dev')
    ).toBe(false);
  });

  it('evaluates on the production host', () => {
    expect(shouldEvaluateDarkModeExperimentFromHost('openstory.so')).toBe(true);
  });
});

describe('readDarkModeOverride', () => {
  it('prefers the query param over localStorage', () => {
    expect(
      readDarkModeOverride({
        search: `?${DARK_MODE_OVERRIDE_QUERY}=control`,
        storageGet: () => 'test',
      })
    ).toBe('control');
  });

  it('falls back to localStorage', () => {
    expect(
      readDarkModeOverride({
        search: '',
        storageGet: (key) =>
          key === DARK_MODE_OVERRIDE_STORAGE_KEY ? 'test' : null,
      })
    ).toBe('test');
  });
});

describe('DARK_MODE_BOOT_SCRIPT', () => {
  it('applies the sticky cookie name and override keys', () => {
    expect(DARK_MODE_BOOT_SCRIPT).toContain(DARK_MODE_VARIANT_COOKIE);
    expect(DARK_MODE_BOOT_SCRIPT).toContain(DARK_MODE_OVERRIDE_STORAGE_KEY);
    expect(DARK_MODE_BOOT_SCRIPT).toContain(DARK_MODE_OVERRIDE_QUERY);
    expect(DARK_MODE_BOOT_SCRIPT).toContain('classList.add("dark")');
  });
});
