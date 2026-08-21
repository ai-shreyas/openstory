/**
 * Device-code login for the public API (#1219, RFC 8628 shape).
 *
 * Thin layer over Better Auth's `deviceAuthorization` plugin, which owns the
 * code lifecycle. The one thing the plugin can't do is hand back an API key —
 * its `/device/token` mints a *session* — so `exchangeDeviceCode` redeems the
 * code, swaps the session for a normal team-scoped `osk_` key (revocable under
 * Settings → Developer), and discards the session.
 */

import { getAuth } from '@/lib/auth/config';
import { resolveUserTeam } from '@/lib/db/scoped';
import { APIError } from 'better-auth/api';
import { z } from 'zod';

/** Single first-party client; the plugin requires a `client_id` on the wire. */
export const DEVICE_CLIENT_ID = 'openstory-api';
/** Dashboard approval page; keep in sync with `verificationUri` in auth/config.ts. */
export const DEVICE_VERIFICATION_PATH = '/device';

export type DeviceTokenResult =
  | {
      status:
        | 'authorization_pending'
        | 'slow_down'
        | 'expired_token'
        | 'access_denied';
    }
  | { status: 'approved'; apiKey: string; team: { id: string; name: string } };

const PLUGIN_ERRORS = [
  'authorization_pending',
  'slow_down',
  'expired_token',
  'access_denied',
] as const;
const pluginErrorCode = z.object({ error: z.enum(PLUGIN_ERRORS) });

/**
 * One poll of the plugin's `/device/token`. Pending/denied/expired come back as
 * statuses rather than throws; unknown codes read as `expired_token` so the
 * endpoint isn't an existence oracle. Approval consumes the code (plugin) and
 * mints the key here — a second call with the same code is `expired_token`.
 */
export async function exchangeDeviceCode(
  deviceCode: string
): Promise<DeviceTokenResult> {
  const auth = getAuth();
  let accessToken: string;
  try {
    ({ access_token: accessToken } = await auth.api.deviceToken({
      body: {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
        client_id: DEVICE_CLIENT_ID,
      },
    }));
  } catch (error) {
    if (error instanceof APIError) {
      const parsed = pluginErrorCode.safeParse(error.body);
      if (parsed.success) return { status: parsed.data.error };
      // invalid_grant = unknown/used code; anything else is a real failure.
      if (
        z.object({ error: z.literal('invalid_grant') }).safeParse(error.body)
          .success
      ) {
        return { status: 'expired_token' };
      }
    }
    throw error;
  }

  const { internalAdapter } = await auth.$context;
  const found = await internalAdapter.findSession(accessToken);
  // The session was only ever a carrier for the user id; never leave it live.
  await internalAdapter.deleteSession(accessToken);
  if (!found) throw new Error('Device login session vanished before exchange');
  const userId = found.user.id;

  const team = await resolveUserTeam(userId);
  if (!team) throw new Error('No team found for user');

  const created = await auth.api.createApiKey({
    body: {
      userId,
      name: `Agent login · ${new Date().toISOString().slice(0, 10)}`,
      prefix: 'osk_',
    },
  });
  return {
    status: 'approved',
    apiKey: created.key,
    team: { id: team.teamId, name: team.teamName },
  };
}
