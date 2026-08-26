/**
 * Images and Videos create flow (#1274).
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
  estimateStudioVideoCost,
  gateEstimate,
} from '@/lib/billing/cost-estimation';
import { multiplyMicros, type Microdollars } from '@/lib/billing/money';
import { requireCredits } from '@/lib/billing/preflight';
import { requireGenerationAllowed } from '@/lib/compliance/generation-gate';
import type { ScopedDb } from '@/lib/db/scoped';
import type { GeneratedAssetInput } from '@/lib/db/schema';
import { getLogger } from '@/lib/observability/logger';
import {
  studioEndpointId,
  studioModelName,
  type StudioCreateInput,
  type StudioCreateResult,
} from '@/lib/studio/schema';
import { snapStudioVideoDuration } from '@/lib/studio/text-to-video';
import { triggerWorkflow } from '@/lib/workflow/client';
import type { StudioGenerationWorkflowInput } from '@/lib/workflow/types';

const logger = getLogger(['openstory', 'studio', 'create']);

function estimateStudioCost(
  input: StudioCreateInput,
  pricing: Awaited<ReturnType<typeof getEffectiveFalPricing>>
): Microdollars {
  if (input.activity === 'image') {
    const perImage = gateEstimate(
      estimateImageCost(input.imageModel, input.aspectRatio, 1, {
        pricing,
        edit: input.referenceImages.length > 0,
      }),
      { model: input.imageModel, operation: 'studio-image' }
    );
    return multiplyMicros(perImage, input.count);
  }

  const duration = snapStudioVideoDuration(input.duration, input.videoModel);
  const perVideo = gateEstimate(
    estimateStudioVideoCost(input.videoModel, duration, {
      pricing,
      mode: input.mode,
    }),
    { model: input.videoModel, operation: 'studio-video' }
  );
  return multiplyMicros(perVideo, input.count);
}

function snapshotInput(input: StudioCreateInput): GeneratedAssetInput {
  if (input.activity === 'video') {
    const snapshot: GeneratedAssetInput = {
      prompt: input.prompt,
      aspectRatio: input.aspectRatio,
      videoModel: input.videoModel,
      duration: snapStudioVideoDuration(input.duration, input.videoModel),
      count: input.count,
      mode: input.mode,
    };
    if (input.generateAudio !== undefined) {
      snapshot.generateAudio = input.generateAudio;
    }
    if (input.mode === 'reference') {
      snapshot.referenceImages = input.referenceImages;
      snapshot.referenceVideos = input.referenceVideos;
      snapshot.referenceAudio = input.referenceAudio;
    }
    if (input.mode === 'frames' && input.startImageUrl) {
      snapshot.startImageUrl = input.startImageUrl;
      if (input.endImageUrl) snapshot.endImageUrl = input.endImageUrl;
    }
    return snapshot;
  }
  return {
    prompt: input.prompt,
    aspectRatio: input.aspectRatio,
    imageModel: input.imageModel,
    count: input.count,
    ...(input.referenceImages.length > 0 && {
      referenceImages: input.referenceImages,
    }),
  };
}

/**
 * Reserve `count` studio rows and trigger a `/studio` run for each.
 */
export async function createStudioAssets(
  scopedDb: ScopedDb,
  input: StudioCreateInput
): Promise<StudioCreateResult> {
  if (input.activity === 'video') {
    input = {
      ...input,
      duration: snapStudioVideoDuration(input.duration, input.videoModel),
    };
  }
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

    const workflowInput: StudioGenerationWorkflowInput = {
      userId: scopedDb.userId,
      teamId: scopedDb.teamId,
      assetId: row.id,
      input,
    };

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
