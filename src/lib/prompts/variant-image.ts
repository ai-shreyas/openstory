import type { ImageSize } from '@/lib/constants/aspect-ratios';

type GridLayout = {
  cols: number;
  rows: number;
};

/**
 * Get the grid layout description based on shape
 */
function getLayoutDescription(
  imageSize: ImageSize,
  grid: GridLayout,
  count: number
): string {
  if (grid.rows === 1) {
    return `${count} side-by-side portrait panels in a 16:9 landscape image. Each column is a full 9:16 composition.`;
  }
  const ratio = imageSize === 'square_hd' ? '1:1 square' : '16:9 landscape';
  return `${grid.cols}x${grid.rows} grid (${count} panels) in a ${ratio} image.`;
}

/**
 * Generate variant image prompt with aspect ratio context and optional scene description
 */
export function getVariantImagePrompt(
  imageSize: ImageSize,
  scenePrompt?: string,
  grid: GridLayout = { cols: 3, rows: 3 }
): string {
  const count = grid.cols * grid.rows;
  const layout = getLayoutDescription(imageSize, grid, count);

  const sceneContext = scenePrompt ? `\nScene: ${scenePrompt}\n` : '';

  return `${count}-panel cinematic storyboard sheet derived from Image 1. Mix Wide, Medium, and Tight shots of the same scene. No borders between panels.

Layout: ${layout}
${sceneContext}
Match Image 1 exactly: same character(s) (face, hair, skin, clothing), lighting, color grade, and texture.

No text, dialogue bubbles, scene numbers, or watermarks.
`;
}
