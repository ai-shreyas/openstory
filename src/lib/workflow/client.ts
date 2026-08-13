import { getEnv } from '#env';
import {
  getCfBindingForTriggerPath,
  triggerCfWorkflow,
} from '@/lib/workflow/trigger-bindings';
import type { CloudflareEnv } from '@/lib/workflow/types';
import {
  assertCanWrite,
  resolveEnforcementState,
} from '@/lib/compliance/enforcement';
import { requireGenerationAllowed } from '@/lib/compliance/generation-gate';
import { loadComplianceRecords } from '@/lib/db/scoped';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'client']);

/**
 * Triggers that produce nothing new and so survive a generation pause.
 *
 * An export stitches assets the account already made and already paid for.
 * Blocking it under `generation_suspended` would mean a portrait complaint about
 * one clip also holds the user's unrelated finished work hostage — which is the
 * disproportionality the separate `generation_suspended` /
 * `account_suspended` rungs exist to avoid. These still require write access,
 * so a fully suspended (read-only) account cannot run them.
 */
const WRITE_ONLY_TRIGGERS = new Set(['sequence-export']);

/**
 * Refuse to start durable work for a restricted account.
 *
 * Reads the account's enforcement rows and resolves them with the shared
 * policy, so this agrees with the banner the user sees and with the gate at the
 * entry points. Throws `AccountRestrictedError` (403).
 *
 * **This is a live D1 read, and three workflows call `triggerWorkflow` from
 * inside a run** (regenerate-shots, scene-split, shot-images), so those fan-outs
 * now read enforcement mid-run. That is deliberate and is the same category as
 * the sanctioned spawn-time billing guard: the ban must stop work that has not
 * started yet, which is only expressible as a live read. The consequence to know
 * about is that suspending an account mid-fan-out fails the parent run with
 * children partly spawned — correct for a ban, and the reason enforcement is
 * applied to accounts rather than to individual runs. Child spawns via
 * `spawnAndAwaitChild` use `binding.create()` directly and are not gated here.
 */
function optionalPayloadString(body: object, key: string): string | undefined {
  const value: unknown = Reflect.get(body, key);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function assertTriggerAllowed(
  urlPath: string,
  body: { userId: string; teamId: string }
): Promise<void> {
  const key = urlPath.startsWith('/') ? urlPath.slice(1) : urlPath;
  if (WRITE_ONLY_TRIGGERS.has(key)) {
    const { enforcement } = await loadComplianceRecords(
      body.userId,
      body.teamId
    );
    assertCanWrite(resolveEnforcementState(enforcement));
    return;
  }

  // Enforcement + identity. Under `all_generation` this is what makes the
  // policy real for every trigger; under the default policy only restricted
  // (provider, model) pairs require a verified identity. Unknown payload
  // shapes omit those fields and stay unrestricted — same fail-open as
  // `isRestrictedModel`.
  await requireGenerationAllowed({
    userId: body.userId,
    teamId: body.teamId,
    provider: optionalPayloadString(body, 'provider'),
    model:
      optionalPayloadString(body, 'model') ??
      optionalPayloadString(body, 'endpointId') ??
      optionalPayloadString(body, 'modelKey'),
  });
}

/**
 * Trigger a durable workflow.
 *
 * Every workflow runs on Cloudflare Workflows: this resolves the binding for
 * `urlPath` and calls `binding.create()`. Returns the workflow instance id
 * (persisted as `workflowRunId` on the relevant DB row).
 *
 * `options.deduplicationId` becomes the instance id suffix — pass a stable
 * value to make a trigger idempotent. `label`/`retries`/`retryDelay` are
 * accepted for backwards-compatibility with existing call sites but are no-ops
 * under Cloudflare Workflows (retry policy is configured per `step.do`/on the
 * workflow class; observability comes from the instance id + tail logs).
 */
export async function triggerWorkflow<
  T extends { userId: string; teamId: string },
>(
  urlPath: string,
  body: T,
  options?: {
    deduplicationId?: string;
    label?: string;
    retries?: number;
    retryDelay?: string;
  }
): Promise<string> {
  logger.info('[TriggerWorkflow]', { url: urlPath, body, options });

  // Enforcement backstop (#1180). Every generation in the app funnels through
  // here, and the payload carries `userId`/`teamId` by contract — so this is the
  // one place a compliance gate cannot be forgotten by a future endpoint. The
  // model-aware identity check lives at the entry points that know which model
  // they are about to run (`requireGenerationAllowed`); this covers the part
  // that must never be skippable: a restricted account must not start work.
  await assertTriggerAllowed(urlPath, body);

  const env = getEnv();
  if (env.E2E_TEST === 'true' && env.E2E_FULL_PIPELINE !== 'true') {
    const mockId = options?.deduplicationId ?? `mock-${Date.now()}`;
    logger.info(`Skipping workflow trigger: ${urlPath} (mock ID: ${mockId})`);
    return mockId;
  }

  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- getEnv()'s type is platform-dependent; CF runtime guarantees Cloudflare.Env shape with workflow bindings present
  const cfEnv = env as unknown as CloudflareEnv;
  const binding = getCfBindingForTriggerPath(urlPath, cfEnv);
  const result = await triggerCfWorkflow({
    binding,
    triggerPath: urlPath,
    body,
    env: cfEnv,
    deduplicationId: options?.deduplicationId,
  });
  logger.info('[TriggerWorkflow] Response', { result });
  return result.workflowRunId;
}
