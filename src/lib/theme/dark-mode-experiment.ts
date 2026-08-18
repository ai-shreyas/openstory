/**
 * PostHog experiment #1186 — `dark-mode-default`.
 *
 * Control follows `prefers-color-scheme`. Test forces dark via `html.dark`
 * even when the OS is in light mode. Assignment is sticky in a cookie so
 * return visits apply before paint (see `DARK_MODE_BOOT_SCRIPT`).
 */

export const DARK_MODE_DEFAULT_FLAG = 'dark-mode-default';

export const DARK_MODE_VARIANT_COOKIE = 'os_dark_mode_default';
export const DARK_MODE_DISTINCT_COOKIE = 'os_ph_distinct_id';

/**
 * localStorage key for local / preview overrides. Ignored in production
 * (`evaluate === true`) so a leftover key cannot skip flag exposure.
 */
export const DARK_MODE_OVERRIDE_STORAGE_KEY = 'os:dark-mode-default';

/**
 * Query param for local / preview overrides (`?os_dark_mode=test`).
 * Production ignores it (same reason as the localStorage key).
 */
export const DARK_MODE_OVERRIDE_QUERY = 'os_dark_mode';

const DARK_MODE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;

export type DarkModeVariant = 'control' | 'test';

export function parseDarkModeVariant(
  value: string | boolean | null | undefined
): DarkModeVariant | null {
  return value === 'control' || value === 'test' ? value : null;
}

export function shouldForceDark(
  variant: string | boolean | null | undefined
): boolean {
  return variant === 'test';
}

export function readCookieFromHeader(
  cookieHeader: string,
  name: string
): string | undefined {
  const prefix = `${name}=`;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      try {
        return decodeURIComponent(trimmed.slice(prefix.length));
      } catch {
        return trimmed.slice(prefix.length);
      }
    }
  }
  return undefined;
}

export function assignmentFromCookies(args: {
  variant: string | undefined;
  distinctId: string | undefined;
}): { variant: DarkModeVariant | null; distinctId: string | null } {
  const distinctId = args.distinctId?.trim();
  return {
    variant: parseDarkModeVariant(args.variant),
    distinctId: distinctId ? distinctId : null,
  };
}

/** Stamp the variant onto server-side product events so signup counts. */
export function darkModeFeatureProperties(
  variant: DarkModeVariant | null
): Record<string, string> {
  if (!variant) return {};
  return { [`$feature/${DARK_MODE_DEFAULT_FLAG}`]: variant };
}

/**
 * Production-only host check used on the client. Server uses
 * `isLocalRequestHost` + `isPreviewDeployment` instead (more accurate).
 */
export function shouldEvaluateDarkModeExperimentFromHost(
  hostname: string
): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    return false;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  if (host.includes('pr-')) return false;
  return true;
}

export function isDocumentDark(): boolean {
  if (typeof document !== 'undefined') {
    if (document.documentElement.classList.contains('dark')) return true;
  }
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Injectable `document.documentElement` stand-in for unit tests. */
export type DarkModeRoot = {
  classList: {
    add: (token: string) => void;
    remove: (token: string) => void;
  };
  style: {
    colorScheme: string;
    removeProperty: (property: string) => void;
  };
};

function defaultDarkModeRoot(): DarkModeRoot | null {
  if (typeof document === 'undefined') return null;
  return document.documentElement;
}

export function applyDarkModeVariant(
  variant: DarkModeVariant | null,
  root: DarkModeRoot | null = defaultDarkModeRoot()
): void {
  if (!root) return;
  if (variant === 'test') {
    root.classList.add('dark');
    root.style.colorScheme = 'dark';
    return;
  }
  root.classList.remove('dark');
  root.style.removeProperty('color-scheme');
}

/** Injectable cookie writer for unit tests. */
export type DarkModeCookieWriter = (cookie: string) => void;

export function writeBrowserDarkModeCookies(args: {
  variant: DarkModeVariant;
  distinctId?: string;
  writeCookie?: DarkModeCookieWriter;
  protocol?: string;
}): void {
  const write =
    args.writeCookie ??
    (typeof document === 'undefined'
      ? undefined
      : (cookie: string) => {
          document.cookie = cookie;
        });
  if (!write) return;
  const protocol =
    args.protocol ??
    (typeof location !== 'undefined' ? location.protocol : 'http:');
  const secure = protocol === 'https:';
  const attrs = `; Path=/; Max-Age=${DARK_MODE_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${
    secure ? '; Secure' : ''
  }`;
  write(
    `${DARK_MODE_VARIANT_COOKIE}=${encodeURIComponent(args.variant)}${attrs}`
  );
  if (args.distinctId) {
    write(
      `${DARK_MODE_DISTINCT_COOKIE}=${encodeURIComponent(args.distinctId)}${attrs}`
    );
  }
}

/**
 * Signup-side experiment wiring: alias the anonymous device id onto `user.id`
 * (only when they differ) and stamp `$feature/dark-mode-default` for both the
 * event and the person. Pure — the auth hook applies `alias` / spreads
 * `featureProperties`. Does not import Better Auth.
 */
export function signupDarkModeAnalytics(args: {
  userId: string;
  assignment: { variant: DarkModeVariant | null; distinctId: string | null };
}): {
  alias: { distinctId: string; alias: string } | null;
  featureProperties: Record<string, string>;
} {
  const { userId, assignment } = args;
  const alias =
    assignment.distinctId && assignment.distinctId !== userId
      ? { distinctId: userId, alias: assignment.distinctId }
      : null;
  return {
    alias,
    featureProperties: darkModeFeatureProperties(assignment.variant),
  };
}

export function readDarkModeOverride(args?: {
  search?: string;
  storageGet?: (key: string) => string | null;
  storageSet?: (key: string, value: string) => void;
}): DarkModeVariant | null {
  const search =
    args?.search ??
    (typeof window === 'undefined' ? '' : window.location.search);
  const fromQuery = parseDarkModeVariant(
    new URLSearchParams(search).get(DARK_MODE_OVERRIDE_QUERY)
  );
  if (fromQuery) {
    try {
      const set =
        args?.storageSet ??
        (!args?.storageGet && typeof localStorage !== 'undefined'
          ? (key: string, value: string) => localStorage.setItem(key, value)
          : undefined);
      // Persist so a later in-app redirect (e.g. /docs → /docs/...) keeps the override.
      set?.(DARK_MODE_OVERRIDE_STORAGE_KEY, fromQuery);
    } catch {
      // private mode
    }
    return fromQuery;
  }

  try {
    const get =
      args?.storageGet ??
      (typeof localStorage === 'undefined'
        ? undefined
        : (key: string) => localStorage.getItem(key));
    return parseDarkModeVariant(get?.(DARK_MODE_OVERRIDE_STORAGE_KEY));
  } catch {
    return null;
  }
}

/**
 * Runs in `<head>` before CSS so a sticky `test` assignment does not flash
 * light on return visits. Query / localStorage overrides apply only off
 * production (same host gate as `shouldEvaluateDarkModeExperimentFromHost`).
 */
export const DARK_MODE_BOOT_SCRIPT = `(function(){try{var host=location.hostname.toLowerCase();var evaluate=host!=="localhost"&&host!=="127.0.0.1"&&host!=="::1"&&!/^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(host)&&host.indexOf("pr-")===-1;var q=null;var s=null;if(!evaluate){q=new URLSearchParams(location.search).get(${JSON.stringify(DARK_MODE_OVERRIDE_QUERY)});if(q==="test"||q==="control"){try{localStorage.setItem(${JSON.stringify(DARK_MODE_OVERRIDE_STORAGE_KEY)},q)}catch(e){}}try{s=localStorage.getItem(${JSON.stringify(DARK_MODE_OVERRIDE_STORAGE_KEY)})}catch(e){}}var c=document.cookie.match(/(?:^|; )${DARK_MODE_VARIANT_COOKIE}=([^;]*)/);var v=q||s||(c&&decodeURIComponent(c[1]));if(v==="test"){document.documentElement.classList.add("dark");document.documentElement.style.colorScheme="dark"}else if(v==="control"){document.documentElement.classList.remove("dark");document.documentElement.style.colorScheme=""}}catch(e){}})();`;
