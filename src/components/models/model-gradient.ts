/**
 * Deterministic placeholder gradient for model cards. modelschemas carries no
 * thumbnails for fal, so cards get a stable endpoint-id-seeded color wash —
 * same conic treatment as the styles library's palette gradient
 * (style-gradient.ts), with hues hashed from the id instead of a palette.
 */
export function getModelGradient(endpointId: string): string {
  let hash = 0;
  for (let i = 0; i < endpointId.length; i++) {
    hash = (hash * 31 + endpointId.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  const stops = [hue, (hue + 40) % 360, (hue + 300) % 360, hue]
    .map((h) => `hsl(${h} 45% 35%)`)
    .join(', ');
  return `conic-gradient(from 135deg, ${stops})`;
}
