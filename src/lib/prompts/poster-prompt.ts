import type { StyleConfig } from '@/lib/db/schema/libraries';

const MAX_PROMPT_LENGTH = 2000;
const MAX_SCRIPT_LENGTH = 500;
const MAX_SCENE_TEXT_LENGTH = 1500;

const SKETCH_SUFFIX =
  'Loose pencil line drawing on white paper, quick gestural strokes, minimal detail. Simple placeholder figures with blank featureless faces, basic shapes for the setting, flat grey marker shading. Monochrome, no colour, no rendering, no realism, no photographic detail.';

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
 *
 * Previews are stand-ins rendered before any character/location reference
 * exists, so anything rendered "for real" is wrong by construction and reads
 * as inconsistency (or worse, as the final look) — #1277. Ask for a rough
 * monochrome storyboard sketch instead: featureless figures, no detail to be
 * inconsistent about. Deliberately ignores the style config for the same
 * reason — a photoreal style would pull the sketch back toward realism.
 */
export function buildPreviewPrompt(sceneText: string): string {
  const excerpt = sceneText.slice(0, MAX_SCENE_TEXT_LENGTH);

  return clampPrompt(
    [
      `Rough storyboard sketch. ${excerpt}.`,
      SKETCH_SUFFIX,
      NO_TEXT_SUFFIX,
    ].join(' ')
  );
}
