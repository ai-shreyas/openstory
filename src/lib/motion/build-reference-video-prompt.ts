/**
 * Build reference-to-video input (prompt + image_urls) from the rendered still
 * + cast/element reference images (#873).
 *
 * Unlike Kling (whose `elements` field rides on the normal image-to-video
 * endpoint), models in `MOTION_REFERENCE_ENDPOINTS` accept references only on
 * a separate reference-to-video endpoint that has NO start-frame `image_url`.
 * It takes an `image_urls[]` array whose entries are bound to prompt tokens —
 * Seedance's `@Image1…N`, Gemini Omni Flash's `<IMAGE_REF_0>…` — via the
 * endpoint's `tag` config. We therefore pass the rendered still first — the
 * scene anchor that carries composition/framing — followed by the cast/element
 * sheets, and append a legend so the model knows which reference is which. The
 * still is the strongest reference rather than a literal first frame (the
 * tradeoff for gaining identity refs on these endpoints).
 *
 * The endpoint's `maxImages` caps the total; the still consumes one slot, so
 * at most `maxImages - 1` references are taken.
 */

import type { MotionReferenceEndpointConfig } from '@/lib/ai/models';
import type { ReferenceImageDescription } from '@/lib/prompts/reference-image-prompt';
import { appendLegendWithinLimit } from './reference-legend';

export function buildReferenceVideoPrompt(
  config: MotionReferenceEndpointConfig,
  basePrompt: string,
  startImageUrl: string,
  references: ReferenceImageDescription[],
  maxPromptLength?: number
): { prompt: string; imageUrls: string[] } {
  // The still always takes the first slot; cast/element refs fill the rest.
  const usable = references
    .filter((ref) => ref.referenceImageUrl)
    .slice(0, config.maxImages - 1);

  const imageUrls = [
    startImageUrl,
    ...usable.map((ref) => ref.referenceImageUrl),
  ];

  const legendLines = [
    `${config.tag(1)}: the established shot — match its composition, framing, setting, and lighting.`,
    ...usable.map(
      (ref, index) =>
        `${config.tag(index + 2)}: ${ref.description} — keep visually consistent throughout the shot.`
    ),
  ];
  const legend = `Reference images:\n${legendLines.join('\n')}`;

  return {
    prompt: appendLegendWithinLimit(basePrompt, legend, maxPromptLength),
    imageUrls,
  };
}
