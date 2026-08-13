import type { StyleConfig } from '@/lib/db/schema/libraries';

const MAX_PROMPT_LENGTH = 2000;
const MAX_SCRIPT_LENGTH = 500;
const MAX_SCENE_TEXT_LENGTH = 1500;

const NO_TEXT_SUFFIX =
  'No text, no titles, no subtitles, no watermarks, no letters, no words, no signs, no UI elements.';

function formatStyleDetails(styleConfig: StyleConfig): string {
  const details = [
    `Art style: ${styleConfig.look.artStyle}`,
    `Mood: ${styleConfig.look.mood}`,
    `Lighting: ${styleConfig.look.lighting}`,
  ];

  return details.join('. ') + '.';
}

function clampPrompt(prompt: string): string {
  if (prompt.length <= MAX_PROMPT_LENGTH) return prompt;
  return prompt.slice(0, MAX_PROMPT_LENGTH - 3) + '...';
}

/**
 * Build an image generation prompt for a sequence poster image.
 * Combines the sequence title, opening script text, and style config
 * into a single prompt suitable for fast preview image generation.
 */
export function buildPosterPrompt(
  title: string,
  script: string,
  styleConfig?: StyleConfig
): string {
  const scriptExcerpt = script.slice(0, MAX_SCRIPT_LENGTH).trim();

  const parts: string[] = [
    `A cinematic establishing shot for "${title}".`,
    `Opening scene: ${scriptExcerpt}`,
  ];

  if (styleConfig) {
    const style = formatStyleDetails(styleConfig);
    if (style) parts.push(style);
  }

  parts.push(NO_TEXT_SUFFIX);
  return clampPrompt(parts.join(' '));
}

/**
 * Build an image generation prompt for a fast scene preview.
 * Uses the scene's script extract and style config to produce a
 * cinematic still suitable for quick preview image generation.
 */
export function buildPreviewPrompt(
  sceneText: string,
  styleConfig?: StyleConfig
): string {
  const excerpt = sceneText.slice(0, MAX_SCENE_TEXT_LENGTH);

  const parts: string[] = [`Cinematic film still. ${excerpt}.`];

  if (styleConfig) {
    const style = formatStyleDetails(styleConfig);
    if (style) parts.push(style);
  }

  parts.push(NO_TEXT_SUFFIX);
  return clampPrompt(parts.join(' '));
}
