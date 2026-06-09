/**
 * Schema-Driven Model Input Builder
 *
 * Builds the fal.ai request body for a video model using generated
 * Zod transforms. Each transform accepts our internal camelCase format
 * (numeric duration, imageUrl) and produces the API's snake_case format
 * with correctly-typed duration values.
 */

import type { IMAGE_TO_VIDEO_MODELS, ImageToVideoModel } from '@/lib/ai/models';
import type { z } from 'zod';
import { buildKlingElementsInput } from './build-kling-elements';
import { MOTION_TRANSFORMS } from './endpoint-map';
import type { GenerateMotionOptions } from './motion-generation';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'motion', 'build-model-input']);

/** Intentional deviations from API defaults */
const QUALITY_OVERRIDES: Partial<
  Record<ImageToVideoModel, Record<string, unknown>>
> = {
  veo3_1: { resolution: '1080p' },
  seedance_v2: { resolution: '720p' },
};

type ModelOutputMap = {
  [K in ImageToVideoModel]: z.output<
    (typeof MOTION_TRANSFORMS)[(typeof IMAGE_TO_VIDEO_MODELS)[K]['id']]
  >;
};

export function buildModelInput<T extends ImageToVideoModel>(
  options: GenerateMotionOptions,
  modelConfig: (typeof IMAGE_TO_VIDEO_MODELS)[T],
  modelKey: T
): ModelOutputMap[T] {
  const endpointId: (typeof IMAGE_TO_VIDEO_MODELS)[T]['id'] = modelConfig.id;
  const transform = MOTION_TRANSFORMS[endpointId];
  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- defensive guard for exhaustiveness
  if (!transform) {
    throw new Error(
      `No motion transform registered for endpoint: ${endpointId}`
    );
  }
  // Reference images (#873): only Kling v3 Pro accepts them, via its `elements`
  // field. Build the elements array and append the matching `@ElementN` legend
  // to the prompt. For every other model `references` stays empty, so `prompt`
  // is unchanged and no `elements` key is passed (and the model's apiSchema
  // would strip it anyway).
  const references = options.referenceImages ?? [];
  const kling =
    modelKey === 'kling_v3_pro' && references.length > 0
      ? buildKlingElementsInput(
          options.prompt,
          references,
          modelConfig.maxPromptLength
        )
      : undefined;
  const prompt = kling?.prompt ?? options.prompt;
  const elements = kling?.elements.length ? kling.elements : undefined;

  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion safe to cast here because we know the transform is valid
  const result = transform.parse({
    prompt,
    duration: options.duration,
    imageUrl: options.imageUrl,
    aspectRatio: options.aspectRatio,
    ...QUALITY_OVERRIDES[modelKey],
    ...(elements && { elements }),
    // Pass-through `generate_audio` for audio-capable models. The schema-driven
    // transform forwards unknown keys; models without `generate_audio` strip
    // it during apiSchema.parse.
    ...(options.generateAudio !== undefined && {
      generate_audio: options.generateAudio,
    }),
  }) as ModelOutputMap[T];

  const outputPrompt =
    'prompt' in result && typeof result.prompt === 'string'
      ? result.prompt
      : '';
  const truncated = outputPrompt.length < prompt.length;

  logger.info(
    `model=${modelKey} inputLen=${prompt.length} outputLen=${outputPrompt.length} truncated=${truncated}`
  );
  if (truncated) {
    logger.info(`INPUT prompt:
${prompt}`);
    logger.info(`OUTPUT prompt:
${outputPrompt}`);
  }

  return result;
}
