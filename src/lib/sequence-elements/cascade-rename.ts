/**
 * Cascade an element token rename through every place the old token can be
 * referenced: sequence script text, per-shot metadata (continuity tags,
 * original script extract, prompt strings), and the user-edited
 * imagePrompt/motionPrompt overrides on the shot row.
 *
 * The rewrite is whole-word and case-insensitive on the haystack side (so a
 * lowercase mention inside script prose is still rewritten), but always emits
 * the new token in its canonical UPPERCASE form. We never touch sub-strings of
 * a longer identifier — renaming `BAR` must not affect `BARBER`.
 */

import type { Scene } from '@/lib/ai/scene-analysis.schema';
import type { Shot } from '@/lib/db/schema';

/** Whole-token regex. Boundaries are anything that isn't `[A-Za-z0-9_]`. */
function tokenRegex(token: string): RegExp {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])(${escaped})(?=[^A-Za-z0-9_]|$)`, 'gi');
}

export function replaceTokenInText(
  text: string,
  oldToken: string,
  newToken: string
): string {
  if (!text) return text;
  return text.replace(tokenRegex(oldToken), (_match, prefix: string) => {
    return `${prefix}${newToken}`;
  });
}

function textContainsToken(text: string, token: string): boolean {
  if (!text) return false;
  return tokenRegex(token).test(text);
}

/** Pure rewrite of one shot's Scene metadata. Returns null if nothing changed. */
function renameTokenInScene(
  scene: Scene,
  oldToken: string,
  newToken: string
): Scene | null {
  if (oldToken === newToken) return null;

  let changed = false;
  const next: Scene = { ...scene };

  // continuity.elementTags — uppercase tokens, exact match
  if (scene.continuity) {
    const oldTags = scene.continuity.elementTags ?? [];
    const newTags = oldTags.map((tag) =>
      tag.toUpperCase() === oldToken.toUpperCase() ? newToken : tag
    );
    const tagsDiffer = newTags.some((t, i) => t !== oldTags[i]);
    if (tagsDiffer) {
      next.continuity = { ...scene.continuity, elementTags: newTags };
      changed = true;
    }
  }

  // originalScript.extract — case-insensitive whole-word replace
  if (scene.originalScript.extract) {
    const rewritten = replaceTokenInText(
      scene.originalScript.extract,
      oldToken,
      newToken
    );
    if (rewritten !== scene.originalScript.extract) {
      next.originalScript = { ...scene.originalScript, extract: rewritten };
      changed = true;
    }
  }

  // The generated visual/motion prompts no longer live on `scene.prompts`
  // (#713) — they're in `frame_prompt_versions` / `shot_prompt_versions`,
  // mirrored on `frame.imagePrompt` / `shot.motionPrompt`. Those mirrors (and
  // the selected motion version) are rewritten by the applier, not here.

  return changed ? next : null;
}

export type ShotRenameDelta = {
  shotId: string;
  metadata?: Scene;
  imagePrompt?: string;
  motionPrompt?: string;
};

/**
 * Compute per-shot deltas for a token rename. Shots with no references return
 * null. The image prompt lives on the anchor frame now (#989), so callers pass
 * each shot augmented with its frame's `imagePrompt`; the applier routes the
 * resulting `delta.imagePrompt` to the frame, and `metadata`/`motionPrompt` to
 * the shot.
 */
export function buildShotRenameDeltas(
  shots: ReadonlyArray<Shot & { imagePrompt: string | null }>,
  oldToken: string,
  newToken: string
): ShotRenameDelta[] {
  if (oldToken === newToken) return [];

  const deltas: ShotRenameDelta[] = [];
  for (const shot of shots) {
    const delta: ShotRenameDelta = { shotId: shot.id };
    let touched = false;

    if (shot.metadata) {
      const rewritten = renameTokenInScene(shot.metadata, oldToken, newToken);
      if (rewritten) {
        delta.metadata = rewritten;
        touched = true;
      }
    }

    if (shot.imagePrompt && textContainsToken(shot.imagePrompt, oldToken)) {
      delta.imagePrompt = replaceTokenInText(
        shot.imagePrompt,
        oldToken,
        newToken
      );
      touched = true;
    }

    if (shot.motionPrompt && textContainsToken(shot.motionPrompt, oldToken)) {
      delta.motionPrompt = replaceTokenInText(
        shot.motionPrompt,
        oldToken,
        newToken
      );
      touched = true;
    }

    if (touched) deltas.push(delta);
  }
  return deltas;
}
