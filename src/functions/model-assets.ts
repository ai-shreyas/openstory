/**
 * Generated Asset Server Functions (#458 — direct model access).
 *
 * Create/list/get for `generated_assets`: flat, team-scoped runs of arbitrary
 * fal endpoints picked from the live modelschemas catalog. The create path is
 * the trust boundary: it re-fetches the endpoint's input JSON Schema
 * SERVER-SIDE (never trusting a client-sent schema), validates the input
 * against it, gates credits, reserves the row, and hands off to
 * `AssetGenerationWorkflow`.
 */

import { usdToMicros, type Microdollars } from '@/lib/billing/money';
import { assertModelsEnabled } from '@/lib/flags';
import { requireCredits } from '@/lib/billing/preflight';
import { getLogger } from '@/lib/observability/logger';
import type { ScopedDb } from '@/lib/db/scoped';
import {
  GENERATED_ASSET_ACTIVITIES,
  type GeneratedAssetActivity,
  type GeneratedAssetInput,
  type JsonValue,
} from '@/lib/db/schema';
import {
  fetchModelInputSchema,
  type ModelInputJsonSchema,
} from '@/lib/models/schema-fetch';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { triggerWorkflow } from '@/lib/workflow/client';
import type { AssetGenerationWorkflowInput } from '@/lib/workflow/types';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithTeamMiddleware } from './middleware';

const logger = getLogger(['openstory', 'functions', 'model-assets']);

// ---------------------------------------------------------------------------
// Cost estimates
// ---------------------------------------------------------------------------

/**
 * Conservative flat pre-flight estimates per activity, used ONLY to gate
 * affordability in `requireCredits` (BYOK fal keys skip the gate entirely).
 * fal pricing is unavailable per-model for arbitrary endpoints and the raw
 * queue API reports no `unitsBilled`, so completed runs currently charge
 * NOTHING (`costMicros` stays null) — real charging is a follow-up PR.
 */
const ASSET_COST_ESTIMATES: Record<GeneratedAssetActivity, Microdollars> = {
  image: usdToMicros(0.1),
  video: usdToMicros(1),
  audio: usdToMicros(0.25),
};

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ])
);

const createGeneratedAssetInputSchema = z.object({
  /** fal endpoint id, e.g. `fal-ai/flux-1/dev`. */
  endpointId: z.string().min(1).max(200),
  activity: z.enum(GENERATED_ASSET_ACTIVITIES),
  /** Catalog display name, stored for listing. */
  modelName: z.string().min(1).max(200),
  // Note there is deliberately NO client-sent schema field: the server
  // re-fetches the live schema from modelschemas itself, so the client
  // cannot influence validation.
  input: z.record(z.string(), jsonValueSchema),
});

export type CreateGeneratedAssetData = z.infer<
  typeof createGeneratedAssetInputSchema
>;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a user-submitted endpoint input against the endpoint's live input
 * JSON Schema via zod v4's `z.fromJSONSchema`. Returns the flattened issue
 * list on failure so the UI can surface per-field messages. Throws when the
 * schema itself can't be converted — an input we cannot validate must not
 * reach the credit gate or the provider.
 */
export function validateAssetInput(
  schema: ModelInputJsonSchema,
  input: GeneratedAssetInput
):
  | { success: true }
  | { success: false; issues: Array<{ path: string; message: string }> } {
  const zodSchema = z.fromJSONSchema(schema);
  const parsed = zodSchema.safeParse(input);
  if (parsed.success) return { success: true };
  return {
    success: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Discriminated create result: validation failures are DATA, not thrown —
 * server-fn errors serialize to bare message strings, which would force the
 * client to re-parse per-field issues out of prose. `ok: false` carries the
 * typed issue list straight to `<SchemaForm errors>`.
 */
export type CreateGeneratedAssetResult =
  | { ok: true; id: string; workflowRunId: string }
  | { ok: false; issues: Array<{ path: string; message: string }> };

/**
 * The create flow, separated from the server-fn shell so tests can drive it
 * with a mocked `#db-client` / `triggerWorkflow` (vi.doMock + dynamic import).
 * Order matters: schema validation MUST precede `requireCredits`, which MUST
 * precede the row insert — a rejected input costs nothing and leaves no row.
 */
export async function createGeneratedAsset(
  scopedDb: ScopedDb,
  data: CreateGeneratedAssetData
): Promise<CreateGeneratedAssetResult> {
  const inputSchema = await fetchModelInputSchema(
    data.endpointId,
    data.activity
  );
  const validation = validateAssetInput(inputSchema, data.input);
  if (!validation.success) {
    return { ok: false, issues: validation.issues };
  }

  await requireCredits(scopedDb, ASSET_COST_ESTIMATES[data.activity], {
    errorMessage: `Insufficient credits for ${data.activity} generation`,
  });

  const row = await scopedDb.generatedAssets.insert({
    provider: 'fal',
    endpointId: data.endpointId,
    activity: data.activity,
    modelName: data.modelName,
    input: data.input,
    status: 'queued',
  });

  const workflowInput: AssetGenerationWorkflowInput = {
    userId: scopedDb.userId,
    teamId: scopedDb.teamId,
    assetId: row.id,
    endpointId: data.endpointId,
    activity: data.activity,
    input: data.input,
  };

  let workflowRunId: string;
  try {
    workflowRunId = await triggerWorkflow('/asset', workflowInput, {
      deduplicationId: `asset-${row.id}`,
    });
  } catch (error) {
    // No workflow ever ran, so nothing else will flip this row — without
    // this it would sit 'queued' forever (and with no workflowRunId, the
    // cron reconciler couldn't verify it either).
    await scopedDb.generatedAssets.markFailed(
      row.id,
      'The generation could not be started — please try again.'
    );
    throw error;
  }

  try {
    await scopedDb.generatedAssets.setWorkflowRunId(row.id, workflowRunId);
  } catch (error) {
    // The workflow IS running at this point — failing the request would
    // read as "run failed" and invite a duplicate paid run. The workflow
    // itself flips the row to a terminal status regardless.
    logger.error(
      `Failed to persist workflowRunId ${workflowRunId} for asset ${row.id}`,
      { data: error instanceof Error ? error.message : error }
    );
  }

  return { ok: true, id: row.id, workflowRunId };
}

export const createGeneratedAssetFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(zodValidator(createGeneratedAssetInputSchema))
  .handler(async ({ context, data }) => {
    assertModelsEnabled();
    return createGeneratedAsset(context.scopedDb, data);
  });

// ---------------------------------------------------------------------------
// List / Get
// ---------------------------------------------------------------------------

const listGeneratedAssetsInputSchema = z.object({
  activity: z.enum(GENERATED_ASSET_ACTIVITIES).optional(),
  endpointId: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  /** `id` of the last row of the previous page (keyset pagination). */
  cursor: ulidSchema.optional(),
});

/** Team-scoped newest-first list, filterable by activity / endpoint. */
export const listGeneratedAssetsFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(zodValidator(listGeneratedAssetsInputSchema.optional()))
  .handler(async ({ context, data }) => {
    assertModelsEnabled();
    return context.scopedDb.generatedAssets.list({
      activity: data?.activity,
      endpointId: data?.endpointId,
      limit: data?.limit,
      cursor: data?.cursor,
    });
  });

const getGeneratedAssetInputSchema = z.object({
  id: ulidSchema,
});

/** Single run row — the client polls this while a run is in flight. */
export const getGeneratedAssetFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(zodValidator(getGeneratedAssetInputSchema))
  .handler(async ({ context, data }) => {
    assertModelsEnabled();
    const asset = await context.scopedDb.generatedAssets.getById(data.id);
    if (!asset) {
      throw new Error('Generated asset not found');
    }
    return asset;
  });
