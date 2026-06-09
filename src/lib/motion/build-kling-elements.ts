/**
 * Convert resolved reference images into Kling v3 Pro `elements` input (#873).
 *
 * Kling v3 Pro is the only image-to-video model that accepts reference images:
 * it takes an `elements` array of `{ frontal_image_url, reference_image_urls }`
 * and binds each one to the `@Element1`, `@Element2`, … tokens it finds in the
 * prompt (https://fal.ai/models/fal-ai/kling-video/v3/pro/image-to-video). We
 * have a single sheet/product image per character/element, so each becomes one
 * element keyed on `frontal_image_url`, and we append an `@ElementN` legend to
 * the prompt so the model knows which reference is which.
 *
 * The fal docs cap the combo at 4 reference images total, so we take the first
 * four. The legend is appended within the model's prompt limit (the base prompt
 * is truncated rather than the legend, so the `@ElementN` bindings always
 * survive — a dropped legend would orphan the element images).
 */

import type { ReferenceImageDescription } from '@/lib/prompts/reference-image-prompt';

/** A single Kling v3 combo element built from one reference image. */
export type KlingComboElement = {
  frontal_image_url: string;
  reference_image_urls?: string[];
};

/** fal caps Kling v3 at 4 reference images total (elements + reference images). */
const MAX_KLING_ELEMENTS = 4;

export function buildKlingElementsInput(
  basePrompt: string,
  references: ReferenceImageDescription[],
  maxPromptLength?: number
): { prompt: string; elements: KlingComboElement[] } {
  const usable = references
    .filter((ref) => ref.referenceImageUrl)
    .slice(0, MAX_KLING_ELEMENTS);

  if (usable.length === 0) {
    return { prompt: basePrompt, elements: [] };
  }

  const elements: KlingComboElement[] = usable.map((ref) => ({
    frontal_image_url: ref.referenceImageUrl,
  }));

  const legendLines = usable.map(
    (ref, index) => `@Element${index + 1}: ${ref.description}`
  );
  const legend = `Reference elements — keep each visually consistent with its reference image throughout the shot:\n${legendLines.join('\n')}`;

  return {
    prompt: appendLegendWithinLimit(basePrompt, legend, maxPromptLength),
    elements,
  };
}

/**
 * Append the `@ElementN` legend, truncating the base prompt (never the legend)
 * to stay within `maxPromptLength`. Mirrors `truncateBasePrompt` in
 * reference-image-prompt.ts: the legend is load-bearing (it binds the element
 * images to their prompt tokens) so it must survive even when the base prompt
 * does not fully fit.
 */
function appendLegendWithinLimit(
  basePrompt: string,
  legend: string,
  maxLength?: number
): string {
  const joiner = '\n\n';
  const combined = `${basePrompt}${joiner}${legend}`;
  if (!maxLength || combined.length <= maxLength) return combined;

  const available = maxLength - legend.length - joiner.length - 3; // 3 for '...'
  if (available <= 0) {
    // Legend alone exceeds the limit (only with absurdly long descriptions) —
    // hand it back whole and let the downstream transform clamp it.
    return legend;
  }
  return `${basePrompt.slice(0, available)}...${joiner}${legend}`;
}
