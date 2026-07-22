/**
 * Shared helper: collects all deduplicated fal.ai endpoint IDs from our model configs.
 */
import {
  AUDIO_MODELS,
  EDIT_ENDPOINTS,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
  MOTION_REFERENCE_ENDPOINTS,
} from '@/lib/ai/models';

export function getFalEndpointIds(): string[] {
  const video = Object.values(IMAGE_TO_VIDEO_MODELS).map((m) => m.id);
  const image = Object.values(IMAGE_MODELS).map((m) => m.id);
  const audio = Object.values(AUDIO_MODELS).map((m) => m.id);
  const edit = Object.values(EDIT_ENDPOINTS);
  const motionRef = Object.values(MOTION_REFERENCE_ENDPOINTS).map(
    (m) => m.endpointId
  );

  return [...new Set([...video, ...image, ...edit, ...audio, ...motionRef])];
}
