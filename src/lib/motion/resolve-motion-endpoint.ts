/**
 * Resolve which fal endpoint a motion run submits to (#873).
 *
 * Most models have a single image-to-video endpoint (`modelConfig.id`). A few
 * accept cast/element reference images only on a SEPARATE reference-to-video
 * endpoint that takes `image_urls[]` (tagged `@Image1…@ImageN`) and has no
 * single start-frame `image_url` — see `MOTION_REFERENCE_ENDPOINTS`. When a
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
} from '@/lib/ai/models';

export type MotionEndpointResolution = {
  /** The fal endpoint id to submit to (and key cost/transforms on). */
  endpointId: string;
  /** True when routed to the dedicated reference-to-video endpoint. */
  usesReferenceEndpoint: boolean;
};

export function resolveMotionEndpoint(
  modelKey: ImageToVideoModel,
  hasReferenceImages: boolean
): MotionEndpointResolution {
  const referenceEndpoint = getMotionReferenceEndpoint(modelKey);
  if (hasReferenceImages && referenceEndpoint) {
    return { endpointId: referenceEndpoint, usesReferenceEndpoint: true };
  }
  return {
    endpointId: IMAGE_TO_VIDEO_MODELS[modelKey].id,
    usesReferenceEndpoint: false,
  };
}
