import { getCookie } from '@tanstack/react-start/server';
import {
  DARK_MODE_DISTINCT_COOKIE,
  DARK_MODE_VARIANT_COOKIE,
  assignmentFromCookies,
  type DarkModeVariant,
} from './dark-mode-experiment';

/**
 * Read the sticky experiment assignment off the incoming request.
 * Returns empty values when there is no request context (tests, cron).
 */
export function readDarkModeExperimentAssignment(): {
  variant: DarkModeVariant | null;
  distinctId: string | null;
} {
  try {
    return assignmentFromCookies({
      variant: getCookie(DARK_MODE_VARIANT_COOKIE),
      distinctId: getCookie(DARK_MODE_DISTINCT_COOKIE),
    });
  } catch {
    return { variant: null, distinctId: null };
  }
}
