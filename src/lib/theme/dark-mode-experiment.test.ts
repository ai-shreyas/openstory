import { describe, expect, it } from 'vitest';
import {
  DARK_MODE_BOOT_SCRIPT,
  DARK_MODE_DEFAULT_FLAG,
  DARK_MODE_DISTINCT_COOKIE,
  DARK_MODE_OVERRIDE_QUERY,
  DARK_MODE_OVERRIDE_STORAGE_KEY,
  DARK_MODE_VARIANT_COOKIE,
  applyDarkModeVariant,
  assignmentFromCookies,
  darkModeFeatureProperties,
  parseDarkModeVariant,
  readCookieFromHeader,
  readDarkModeOverride,
  shouldEvaluateDarkModeExperimentFromHost,
  shouldForceDark,
  signupDarkModeAnalytics,
  writeBrowserDarkModeCookies,
  type DarkModeRoot,
} from './dark-mode-experiment';

function fakeRoot(): DarkModeRoot & { tokens: Set<string> } {
  const tokens = new Set<string>();
  const style = {
    colorScheme: '',
    removeProperty(property: string) {
      if (property === 'color-scheme') style.colorScheme = '';
    },
  };
  return {
    tokens,
    classList: {
      add: (token: string) => {
        tokens.add(token);
      },
      remove: (token: string) => {
        tokens.delete(token);
      },
    },
    style,
  };
}

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
  it('prefers the query param over localStorage and persists it', () => {
    const stored: Record<string, string> = {};
    expect(
      readDarkModeOverride({
        search: `?${DARK_MODE_OVERRIDE_QUERY}=control`,
        storageGet: () => 'test',
        storageSet: (key, value) => {
          stored[key] = value;
        },
      })
    ).toBe('control');
    expect(stored[DARK_MODE_OVERRIDE_STORAGE_KEY]).toBe('control');
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

describe('applyDarkModeVariant', () => {
  it('adds html.dark and color-scheme only for test', () => {
    const root = fakeRoot();
    applyDarkModeVariant('test', root);
    expect(root.tokens.has('dark')).toBe(true);
    expect(root.style.colorScheme).toBe('dark');
  });

  it('removes html.dark for control (OS media query takes over)', () => {
    const root = fakeRoot();
    applyDarkModeVariant('test', root);
    applyDarkModeVariant('control', root);
    expect(root.tokens.has('dark')).toBe(false);
    expect(root.style.colorScheme).toBe('');
  });

  it('no-ops without a root (SSR)', () => {
    expect(() => applyDarkModeVariant('test', null)).not.toThrow();
  });
});

describe('writeBrowserDarkModeCookies', () => {
  it('writes the variant and optional distinct id', () => {
    const written: string[] = [];
    writeBrowserDarkModeCookies({
      variant: 'test',
      distinctId: 'anon_1',
      writeCookie: (cookie) => written.push(cookie),
      protocol: 'https:',
    });
    expect(written).toHaveLength(2);
    expect(written[0]).toContain(`${DARK_MODE_VARIANT_COOKIE}=test`);
    expect(written[0]).toContain('Secure');
    expect(written[1]).toContain(`${DARK_MODE_DISTINCT_COOKIE}=anon_1`);
  });
});

describe('signupDarkModeAnalytics', () => {
  it('aliases the anon device id onto user.id and stamps both surfaces', () => {
    const result = signupDarkModeAnalytics({
      userId: 'user_1',
      assignment: { variant: 'test', distinctId: 'anon_1' },
    });
    expect(result.alias).toEqual({ distinctId: 'user_1', alias: 'anon_1' });
    expect(result.featureProperties).toEqual({
      [`$feature/${DARK_MODE_DEFAULT_FLAG}`]: 'test',
    });
  });

  it('does not alias when the assignment already uses user.id', () => {
    const result = signupDarkModeAnalytics({
      userId: 'user_1',
      assignment: { variant: 'control', distinctId: 'user_1' },
    });
    expect(result.alias).toBeNull();
    expect(result.featureProperties).toEqual({
      [`$feature/${DARK_MODE_DEFAULT_FLAG}`]: 'control',
    });
  });

  it('stamps nothing when there was no assignment', () => {
    expect(
      signupDarkModeAnalytics({
        userId: 'user_1',
        assignment: { variant: null, distinctId: null },
      })
    ).toEqual({ alias: null, featureProperties: {} });
  });
});

describe('DARK_MODE_BOOT_SCRIPT', () => {
  it('applies the sticky cookie name and override keys', () => {
    expect(DARK_MODE_BOOT_SCRIPT).toContain(DARK_MODE_VARIANT_COOKIE);
    expect(DARK_MODE_BOOT_SCRIPT).toContain(DARK_MODE_OVERRIDE_STORAGE_KEY);
    expect(DARK_MODE_BOOT_SCRIPT).toContain(DARK_MODE_OVERRIDE_QUERY);
    expect(DARK_MODE_BOOT_SCRIPT).toContain('classList.add("dark")');
  });

  it('gates query/localStorage overrides behind the production host check', () => {
    expect(DARK_MODE_BOOT_SCRIPT).toContain('if(!evaluate)');
    expect(DARK_MODE_BOOT_SCRIPT).toContain('indexOf("pr-")');
  });
});
