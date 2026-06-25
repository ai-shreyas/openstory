/**
 * Shared helper for appending a reference-image legend to a motion prompt (#873).
 *
 * Models that bind reference images to prompt tokens (Kling's `@ElementN`,
 * Seedance's `@ImageN`) need a legend mapping each token to what its image
 * shows. The legend is load-bearing — dropping it orphans the reference images
 * — so when the combined text exceeds the model's prompt limit we truncate the
 * BASE prompt and always keep the legend intact. Mirrors `truncateBasePrompt`
 * in reference-image-prompt.ts.
 */

export function appendLegendWithinLimit(
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
