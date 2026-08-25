/**
 * Prompt-only studio create flow (#1274).
 *
 * Lives outside `src/functions/` because the Start compiler keeps a server
 * fn file's exported helpers in the CLIENT bundle (#1257). The handler
 * references this only inside its body, which the compiler strips.
 *
 * Order: validate models (schema) → compliance gate → credit gate → reserve
 * rows → trigger `/studio`. A rejected prompt costs nothing and leaves no row.
 */

import { getEffectiveFalPricing } from '@/lib/ai/fal-pricing-live';
import {
  estimateImageCost,
  estimateVideoCost,
  gateEstimate,
} from '@/lib/billing/cost-estimation';
import {
  addMicros,
  multiplyMicros,
  type Microdollars,
} from '@/lib/billing/money';
import { requireCredits } from '@/lib/billing/preflight';
import { requireGenerationAllowed } from '@/lib/compliance/generation-gate';
import {
  aspectRatioToImageSize,
  type AspectRatio,
} from '@/lib/constants/aspect-ratios';
import type { ScopedDb } from '@/lib/db/scoped';
import type { GeneratedAssetInput } from '@/lib/db/schema';
import { snapDuration } from '@/lib/motion/snap-duration';
import { getLogger } from '@/lib/observability/logger';
import {
  studioEndpointId,
  studioModelName,
  type StudioCreateInput,
  type StudioCreateResult,
} from '@/lib/studio/schema';
import { triggerWorkflow } from '@/lib/workflow/client';
import type { StudioGenerationWorkflowInput } from '@/lib/workflow/types';

const logger = getLogger(['openstory', 'studio', 'create']);

function estimateStudioCost(
  input: StudioCreateInput,
  pricing: Awaited<ReturnType<typeof getEffectiveFalPricing>>
): Microdollars {
  const perImage = gateEstimate(
    estimateImageCost(input.imageModel, input.aspectRatio, 1, { pricing }),
    { model: input.imageModel, operation: 'studio-image' }
  );

  if (input.activity === 'image') {
    return multiplyMicros(perImage, input.count);
  }

  const duration = snapDuration(input.duration, input.videoModel);
  const perVideo = gateEstimate(
    estimateVideoCost(input.videoModel, duration, { pricing }),
    { model: input.videoModel, operation: 'studio-video' }
  );
  return multiplyMicros(addMicros(perImage, perVideo), input.count);
}

function snapshotInput(input: StudioCreateInput): GeneratedAssetInput {
  const base: GeneratedAssetInput = {
    prompt: input.prompt,
    aspectRatio: input.aspectRatio,
    imageModel: input.imageModel,
    count: input.count,
  };
  if (input.activity === 'video') {
    base.videoModel = input.videoModel;
    base.duration = snapDuration(input.duration, input.videoModel);
    if (input.generateAudio !== undefined) {
      base.generateAudio = input.generateAudio;
    }
  }
  return base;
}

function workflowPayload(
  scopedDb: ScopedDb,
  assetId: string,
  input: StudioCreateInput
): StudioGenerationWorkflowInput {
  const aspectRatio: AspectRatio = input.aspectRatio;
  const payload: StudioGenerationWorkflowInput = {
    userId: scopedDb.userId,
    teamId: scopedDb.teamId,
    assetId,
    activity: input.activity,
    prompt: input.prompt,
    imageModel: input.imageModel,
    aspectRatio,
    imageSize: aspectRatioToImageSize(aspectRatio),
  };
  if (input.activity === 'video') {
    payload.videoModel = input.videoModel;
    payload.duration = snapDuration(input.duration, input.videoModel);
    payload.generateAudio = input.generateAudio;
  }
  return payload;
}

/**
 * Reserve `count` studio rows and trigger a `/studio` run for each.
 */
export async function createStudioAssets(
  scopedDb: ScopedDb,
  input: StudioCreateInput
): Promise<StudioCreateResult> {
  const pricing = await getEffectiveFalPricing();
  const estimatedCost = estimateStudioCost(input, pricing);

  await requireGenerationAllowed({
    userId: scopedDb.userId,
    teamId: scopedDb.teamId,
  });

  await requireCredits(scopedDb, estimatedCost, {
    errorMessage:
      input.activity === 'video'
        ? 'Insufficient credits for video generation'
        : 'Insufficient credits for image generation',
  });

  const endpointId = studioEndpointId(input);
  const modelName = studioModelName(input);
  const snapshot = snapshotInput(input);
  const assets: StudioCreateResult['assets'] = [];

  for (let index = 0; index < input.count; index += 1) {
    const row = await scopedDb.generatedAssets.insert({
      provider: 'fal',
      endpointId,
      activity: input.activity,
      modelName,
      source: 'studio',
      input: snapshot,
      status: 'queued',
    });

    const workflowInput = workflowPayload(scopedDb, row.id, input);

    let workflowRunId: string;
    try {
      workflowRunId = await triggerWorkflow('/studio', workflowInput, {
        deduplicationId: `studio-${row.id}`,
      });
    } catch (error) {
      await scopedDb.generatedAssets.markFailed(
        row.id,
        'The generation could not be started — please try again.'
      );
      throw error;
    }

    try {
      await scopedDb.generatedAssets.setWorkflowRunId(row.id, workflowRunId);
    } catch (error) {
      logger.error(
        `Failed to persist workflowRunId ${workflowRunId} for studio asset ${row.id}`,
        { data: error instanceof Error ? error.message : error }
      );
    }

    assets.push({ id: row.id, workflowRunId });
  }

  return { assets };
}
