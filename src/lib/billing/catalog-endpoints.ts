/**
 * Endpoint IDs for models we expose in the product catalog.
 * Used to ship a small pricing map to the client for ActionCost labels (#1140)
 * instead of the full ~1,350-row fal catalog.
 */

import {
  AUDIO_MODELS,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
} from '@/lib/ai/models';

/** Unique fal endpoint ids for every image / video / audio model we offer. */
export function catalogFalEndpointIds(): string[] {
  const ids = new Set<string>();
  for (const model of Object.values(IMAGE_MODELS)) {
    ids.add(model.id);
  }
  for (const model of Object.values(IMAGE_TO_VIDEO_MODELS)) {
    ids.add(model.id);
  }
  for (const model of Object.values(AUDIO_MODELS)) {
    ids.add(model.id);
  }
  return [...ids];
}
