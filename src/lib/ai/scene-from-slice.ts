/**
 * Local scene fields derived from a verbatim script slice (#1218).
 *
 * Scene-split's LLM call only annotates boundaries. Title, location,
 * time of day, duration, and dialogue are read off the slice the splitter
 * already cut — no second generation, no re-emitted script text.
 * Continuity tags are assigned later from bibles ∩ slice.
 */

import type {
  Continuity,
  DialogueLine,
  SceneMetadata,
} from './scene-analysis.schema';

const SCENE_HEADING_PREFIX = /^(?:INT\.|EXT\.|INT\/EXT\.|I\/E\.)(?:\s|$)/i;
const TIME_SUFFIX =
  /\s*[-–—]\s*(DAY|NIGHT|DAWN|DUSK|EVENING|MORNING|CONTINUOUS|LATER|SAME)\b.*$/i;
const TRANSITION =
  /^(?:CUT TO:|DISSOLVE TO:|FADE IN:|FADE OUT[.:]?|SMASH CUT TO:|MATCH CUT TO:|WIPE TO:)\s*$/i;
const PARENTHETICAL = /^\([^)]+\)$/;
const CHARACTER_CUE = /^[A-Z][A-Z0-9 .'-]*(?:\s*\([^)]+\))?\s*$/;
const INLINE_CUE = /^([A-Z][A-Z0-9 .'-]{1,39}):\s+(.+)$/;

const EMPTY_CONTINUITY: Continuity = {
  characterTags: [],
  environmentTag: '',
  elementTags: null,
  colorPalette: '',
  lightingSetup: '',
  styleTag: '',
};

export type SceneHeading = {
  title: string;
  location: string;
  timeOfDay: string;
};

export function parseSceneHeading(firstLine: string): SceneHeading {
  const trimmed = firstLine.trim();
  if (trimmed.length === 0) {
    return { title: '', location: '', timeOfDay: '' };
  }

  const timeMatch = trimmed.match(TIME_SUFFIX);
  const timeOfDay = timeMatch?.[1]?.toLowerCase() ?? '';
  const isHeading = SCENE_HEADING_PREFIX.test(trimmed) || timeMatch !== null;

  if (!isHeading) {
    const title = trimmed.length > 50 ? `${trimmed.slice(0, 47)}...` : trimmed;
    return { title, location: '', timeOfDay: '' };
  }

  const withoutPrefix = trimmed.replace(
    /^(?:INT\.|EXT\.|INT\/EXT\.|I\/E\.)\s*/i,
    ''
  );
  const core = withoutPrefix.replace(TIME_SUFFIX, '').trim();
  return {
    title: core || trimmed,
    location: trimmed,
    timeOfDay,
  };
}

function firstNonEmptyLine(slice: string): string {
  for (const line of slice.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return '';
}

function isSceneHeading(trimmed: string): boolean {
  return SCENE_HEADING_PREFIX.test(trimmed) || TIME_SUFFIX.test(trimmed);
}

function isCharacterCue(trimmed: string): boolean {
  if (trimmed.length < 2 || trimmed.length > 40) return false;
  if (isSceneHeading(trimmed) || TRANSITION.test(trimmed)) return false;
  if (!CHARACTER_CUE.test(trimmed)) return false;
  return /[A-Z]{2}/.test(trimmed);
}

function cueName(trimmed: string): string {
  return trimmed.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

export function extractDialogueFromSlice(slice: string): DialogueLine[] {
  const lines = slice.split('\n');
  const dialogue: DialogueLine[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]?.trim() ?? '';
    if (trimmed.length === 0) continue;

    const inline = trimmed.match(INLINE_CUE);
    if (inline?.[1] && inline[2] && !isSceneHeading(inline[1])) {
      dialogue.push({
        character: cueName(inline[1]),
        line: inline[2],
        tone: '',
      });
      continue;
    }

    if (!isCharacterCue(trimmed)) continue;

    const character = cueName(trimmed);
    const parts: string[] = [];
    i += 1;
    while (i < lines.length) {
      const next = lines[i]?.trim() ?? '';
      if (next.length === 0) {
        if (parts.length > 0) break;
        i += 1;
        continue;
      }
      if (PARENTHETICAL.test(next)) {
        i += 1;
        continue;
      }
      if (
        isCharacterCue(next) ||
        isSceneHeading(next) ||
        TRANSITION.test(next)
      ) {
        i -= 1;
        break;
      }
      parts.push(next);
      i += 1;
    }
    if (parts.length > 0) {
      dialogue.push({ character, line: parts.join(' '), tone: '' });
    }
  }

  return dialogue;
}

function estimateDurationSeconds(slice: string): number {
  const nonEmpty = slice.split('\n').filter((l) => l.trim().length > 0).length;
  return Math.max(3, Math.min(10, Math.round(nonEmpty / 2)));
}

export function buildSceneFromSlice(
  sceneId: string,
  index: number,
  slice: string
): {
  sceneId: string;
  sceneNumber: number;
  originalScript: { extract: string; dialogue: DialogueLine[] };
  metadata: SceneMetadata;
  continuity: Continuity;
} {
  const heading = parseSceneHeading(firstNonEmptyLine(slice));
  const title = heading.title || `Scene ${index + 1}`;
  return {
    sceneId,
    sceneNumber: index + 1,
    originalScript: {
      extract: slice,
      dialogue: extractDialogueFromSlice(slice),
    },
    metadata: {
      title,
      durationSeconds: estimateDurationSeconds(slice),
      location: heading.location,
      timeOfDay: heading.timeOfDay,
      storyBeat: '',
    },
    continuity: { ...EMPTY_CONTINUITY },
  };
}
