/**
 * Dashboard side of device-code login (#1219): look up a pending `user_code`
 * and approve/deny it under the signed-in user's cookie session, via Better
 * Auth's deviceAuthorization plugin. The agent collects the key from
 * GET /api/v1/device/token — no secret passes through the browser.
 */

import { getAuth } from '@/lib/auth/config';
import { resolveUserTeam } from '@/lib/db/scoped';
import { getLogger } from '@/lib/observability/logger';
import { createServerFn } from '@tanstack/react-start';
import { getRequestHeaders } from '@tanstack/react-start/server';
import { zodValidator } from '@tanstack/zod-adapter';
import { APIError } from 'better-auth/api';
import { z } from 'zod';
import { authWithTeamMiddleware } from './middleware';

const logger = getLogger(['openstory', 'serverFn', 'device-auth']);

const codeSchema = z.object({ userCode: z.string().min(1).max(16) });

/** Accept `abcd efgh` / `abcd-efgh` etc. for what the plugin stores as `ABCDEFGH`. */
const normalizeUserCode = (raw: string) =>
  raw.toUpperCase().replace(/[^A-Z0-9]/g, '');

export const lookupDeviceGrantFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(codeSchema))
  .handler(
    async ({
      data,
      context,
    }): Promise<{ pending: boolean; teamName: string }> => {
      const team = await resolveUserTeam(context.user.id);
      let pending = false;
      try {
        // With a session this also *claims* the code for the user — the
        // plugin refuses to approve an unclaimed code.
        const found = await getAuth().api.deviceVerify({
          headers: getRequestHeaders(),
          query: { user_code: normalizeUserCode(data.userCode) },
        });
        pending = found.status === 'pending';
      } catch (error) {
        if (!(error instanceof APIError)) throw error;
      }
      return { pending, teamName: team?.teamName ?? '' };
    }
  );

export const decideDeviceGrantFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(codeSchema.extend({ approve: z.boolean() })))
  .handler(async ({ data, context }): Promise<{ ok: boolean }> => {
    const auth = getAuth();
    const args = {
      headers: getRequestHeaders(),
      body: { userCode: normalizeUserCode(data.userCode) },
    };
    let ok = true;
    let reason: unknown;
    try {
      await (data.approve
        ? auth.api.deviceApprove(args)
        : auth.api.deviceDeny(args));
    } catch (error) {
      if (!(error instanceof APIError)) throw error;
      ok = false;
      reason = error.body;
    }
    logger.info('device grant decided', {
      userId: context.user.id,
      teamId: context.teamId,
      approve: data.approve,
      ok,
      reason,
    });
    return { ok };
  });
