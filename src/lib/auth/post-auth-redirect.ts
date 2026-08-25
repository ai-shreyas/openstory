import { sanitizeAuthRedirect } from '@/lib/auth/navigation';

/**
 * Post-login destination. A pending enhance/generate click belongs on the
 * composer (`/`); sending a first-time user to the empty sequences dashboard
 * is how #1286 lost the draft.
 */
export function postAuthRedirect(
  redirectTo: string,
  hasPendingIntent: boolean
): string {
  const dest = sanitizeAuthRedirect(redirectTo);
  if (hasPendingIntent && (dest === '/sequences' || dest === '/sequences/')) {
    return '/';
  }
  return dest;
}
