/**
 * Resolve which fal endpoint a motion run submits to (#873).
 *
 * Most models have a single image-to-video endpoint (`modelConfig.id`). A few
 * accept cast/element reference images only on a SEPARATE reference-to-video
 * endpoint that takes `image_urls[]` bound to per-model prompt tokens and has
 * no single start-frame `image_url` — see `MOTION_REFERENCE_ENDPOINTS`. When a
 * scene actually has references AND the model has such an endpoint, route there;
 * otherwise stay on the normal image-to-video endpoint.
 *
 * Models that emit references inline on their normal endpoint (Kling v3 Pro's
 * `elements` field) are NOT in the reference-endpoint map, so they always
 * resolve to image-to-video here and attach refs in `buildModelInput` instead.
 */

import {
  IMAGE_TO_VIDEO_MODELS,
  getMotionReferenceEndpoint,
  type ImageToVideoModel,
  type MotionReferenceEndpointConfig,
} from '@/lib/ai/models';

export type MotionEndpointResolution =
  | {
      /** The fal endpoint id to submit to (and key cost/transforms on). */
      endpointId: string;
      usesReferenceEndpoint: false;
    }
  | {
      endpointId: string;
      /** Routed to the model's dedicated reference-to-video endpoint. */
      usesReferenceEndpoint: true;
      /** Tag syntax + image cap for binding refs into the prompt. */
      referenceConfig: MotionReferenceEndpointConfig;
    };

export function resolveMotionEndpoint(
  modelKey: ImageToVideoModel,
  hasReferenceImages: boolean
): MotionEndpointResolution {
  const referenceConfig = getMotionReferenceEndpoint(modelKey);
  if (hasReferenceImages && referenceConfig) {
    return {
      endpointId: referenceConfig.endpointId,
      usesReferenceEndpoint: true,
      referenceConfig,
    };
  }
  return {
    endpointId: IMAGE_TO_VIDEO_MODELS[modelKey].id,
    usesReferenceEndpoint: false,
  };
}
