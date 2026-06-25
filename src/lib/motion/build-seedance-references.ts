/**
 * Build Seedance 2.0 reference-to-video input from the rendered still + cast/
 * element reference images (#873).
 *
 * Unlike Kling (whose `elements` field rides on the normal image-to-video
 * endpoint), Seedance accepts references only on a separate reference-to-video
 * endpoint that has NO start-frame `image_url`. It takes an `image_urls[]`
 * array whose entries are bound to `@Image1`, `@Image2`, … tokens in the prompt
 * (up to 9 images). We therefore pass the rendered still as `@Image1` — the
 * scene anchor that carries composition/framing — followed by the cast/element
 * sheets as `@Image2…N`, and append a legend so the model knows which reference
 * is which. The still is the strongest reference rather than a literal first
 * frame (the tradeoff for gaining identity refs on this endpoint).
 *
 * fal caps the endpoint at 9 images total; the still consumes one slot, so we
 * take at most the first 8 references.
 */

import type { ReferenceImageDescription } from '@/lib/prompts/reference-image-prompt';
import { appendLegendWithinLimit } from './reference-legend';

/** fal caps Seedance reference-to-video at 9 reference images total. */
const MAX_SEEDANCE_IMAGES = 9;

export function buildSeedanceReferenceInput(
  basePrompt: string,
  startImageUrl: string,
  references: ReferenceImageDescription[],
  maxPromptLength?: number
): { prompt: string; imageUrls: string[] } {
  // The still is always @Image1; cast/element refs fill the remaining slots.
  const usable = references
    .filter((ref) => ref.referenceImageUrl)
    .slice(0, MAX_SEEDANCE_IMAGES - 1);

  const imageUrls = [
    startImageUrl,
    ...usable.map((ref) => ref.referenceImageUrl),
  ];

  const legendLines = [
    '@Image1: the established shot — match its composition, framing, setting, and lighting.',
    ...usable.map(
      (ref, index) =>
        `@Image${index + 2}: ${ref.description} — keep visually consistent throughout the shot.`
    ),
  ];
  const legend = `Reference images:\n${legendLines.join('\n')}`;

  return {
    prompt: appendLegendWithinLimit(basePrompt, legend, maxPromptLength),
    imageUrls,
  };
}
