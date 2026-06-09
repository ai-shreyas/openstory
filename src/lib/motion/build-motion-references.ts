/**
 * Resolve the character + element reference images for a scene's motion
 * generation (#873).
 *
 * Mirrors the image-generation reference resolution
 * (`buildFrameImageWorkflowInput` / `resolveSceneFrameImageReferences`) so
 * motion attaches the SAME cast/element refs the image step does — otherwise
 * characters and elements that look right in the start frame degrade across the
 * generated clip. Only characters and elements are resolved here (locations are
 * out of scope for #873); the result is consumed by `buildKlingElementsInput`
 * and only emitted for models that accept reference images (Kling v3 Pro).
 *
 * Accepts the structural scene shape both the strict `Scene` and the looser
 * `frame.metadata` satisfy, so the single-frame, batch, and full-pipeline
 * trigger sites can all call it without converting.
 */

import type { CharacterMinimal, SequenceElementMinimal } from '@/lib/db/schema';
import { buildCharacterReferenceImages } from '@/lib/prompts/character-prompt';
import { buildElementReferenceImages } from '@/lib/prompts/element-prompt';
import type { ReferenceImageDescription } from '@/lib/prompts/reference-image-prompt';
import {
  matchCharactersToScene,
  matchElementsToScene,
} from '@/lib/workflows/scene-matching';

type SceneReferenceInput = {
  continuity?: {
    characterTags?: string[];
    elementTags?: string[] | null;
  } | null;
  originalScript?: { extract?: string } | null;
} | null;

export function buildMotionReferenceImages(params: {
  scene: SceneReferenceInput;
  characters: CharacterMinimal[];
  elements: SequenceElementMinimal[];
}): ReferenceImageDescription[] {
  const { scene, characters, elements } = params;

  const matchedCharacters = matchCharactersToScene(
    characters,
    scene?.continuity?.characterTags ?? []
  );
  const matchedElements = matchElementsToScene(
    elements,
    scene?.continuity?.elementTags ?? [],
    scene?.originalScript?.extract ?? ''
  );

  return [
    ...buildCharacterReferenceImages(matchedCharacters),
    ...buildElementReferenceImages(matchedElements),
  ];
}
