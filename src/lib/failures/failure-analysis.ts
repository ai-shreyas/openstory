/**
 * Failure Analysis Utility
 * Analyzes shots + sequence to determine what failed and whether smart retry is possible.
 */

import type { Shot } from '@/lib/db/schema/shots';
import type { Sequence } from '@/lib/db/schema/sequences';
import type { ShotWithImage } from '@/lib/shots/shot-with-image';

type FailureCategory =
  | 'image'
  | 'motion'
  | 'music'
  | 'motion-prompts'
  | 'music-prompt';

type ShotFailure = {
  shotId: string;
  orderIndex: number;
  sceneTitle: string;
  error: string | null;
};

type FailureGroup = {
  category: FailureCategory;
  label: string;
  shots: ShotFailure[];
  error?: string | null;
};

export type FailureSummary = {
  requiresFullRetry: boolean;
  headline: string;
  groups: FailureGroup[];
  totalFailures: number;
  hasFailed: boolean;
  error?: string | null;
};

function getSceneTitle(shot: Shot): string {
  return shot.metadata?.metadata?.title || `Scene ${shot.orderIndex + 1}`;
}

function buildHeadline(
  groups: FailureGroup[],
  requiresFullRetry: boolean
): string {
  if (groups.length === 0) {
    if (requiresFullRetry)
      return 'Generation failed \u2014 full retry required';
    return 'No failures detected';
  }

  if (requiresFullRetry) {
    const promptGroups = groups.filter(
      (g) => g.category === 'motion-prompts' || g.category === 'music-prompt'
    );
    if (promptGroups.length > 0) {
      const names = promptGroups.map((g) => g.label).join(' and ');
      return `${names} \u2014 full retry required`;
    }
    return 'Generation failed \u2014 full retry required';
  }

  const parts: string[] = [];
  for (const group of groups) {
    if (group.category === 'image') {
      parts.push(
        `${group.shots.length} image${group.shots.length !== 1 ? 's' : ''} failed`
      );
    } else if (group.category === 'motion') {
      parts.push(
        `${group.shots.length} motion video${group.shots.length !== 1 ? 's' : ''} failed`
      );
    } else if (group.category === 'music') {
      parts.push('music generation failed');
    } else if (group.category === 'music-prompt') {
      parts.push('music prompt generation failed');
    }
  }

  return parts.join(' and ');
}

export function analyzeFailures(
  // The image surface (thumbnailStatus/thumbnailUrl/thumbnailError) moved onto
  // the anchor frame in #989; callers project it back via `projectShotWithImage`
  // so the failure heuristics here read the same legacy field names.
  shots: ShotWithImage[],
  sequence: Sequence
): FailureSummary {
  const groups: FailureGroup[] = [];
  let requiresFullRetry = false;

  // No shots → script analysis failed → full retry
  if (shots.length === 0 && sequence.status === 'failed') {
    return {
      requiresFullRetry: true,
      headline: 'Generation failed \u2014 full retry required',
      groups: [],
      totalFailures: 1,
      hasFailed: true,
      error: sequence.statusError,
    };
  }

  // Failed images
  const failedImageShots = shots.filter((f) => f.thumbnailStatus === 'failed');
  if (failedImageShots.length > 0) {
    groups.push({
      category: 'image',
      label: `${failedImageShots.length} of ${shots.length} images failed`,
      shots: failedImageShots.map((f) => ({
        shotId: f.id,
        orderIndex: f.orderIndex,
        sceneTitle: getSceneTitle(f),
        error: f.thumbnailError,
      })),
    });
  }

  // Failed motion (only shots with thumbnails AND motionPrompt)
  const failedMotionShots = shots.filter(
    (f) => f.videoStatus === 'failed' && f.thumbnailUrl && f.motionPrompt
  );
  if (failedMotionShots.length > 0) {
    groups.push({
      category: 'motion',
      label: `${failedMotionShots.length} of ${shots.length} motion videos failed`,
      shots: failedMotionShots.map((f) => ({
        shotId: f.id,
        orderIndex: f.orderIndex,
        sceneTitle: getSceneTitle(f),
        error: f.videoError,
      })),
    });
  }

  // Detect missing motion prompts (images completed but no motionPrompt)
  const shotsWithImageButNoMotionPrompt = shots.filter(
    (f) => f.thumbnailStatus === 'completed' && !f.motionPrompt
  );
  if (
    shotsWithImageButNoMotionPrompt.length > 0 &&
    sequence.status === 'failed'
  ) {
    requiresFullRetry = true;
    groups.push({
      category: 'motion-prompts',
      label: 'Motion prompts were not generated',
      shots: shotsWithImageButNoMotionPrompt.map((f) => ({
        shotId: f.id,
        orderIndex: f.orderIndex,
        sceneTitle: getSceneTitle(f),
        error: null,
      })),
    });
  }

  // Failed music (only if musicPrompt exists)
  if (sequence.musicStatus === 'failed' && sequence.musicPrompt) {
    groups.push({
      category: 'music',
      label: 'Music generation failed',
      shots: [],
      error: sequence.musicError,
    });
  }

  // Detect missing music prompt
  if (sequence.status === 'failed' && !sequence.musicPrompt) {
    // Only flag as needing full retry if we have shots (otherwise already caught above)
    if (shots.length > 0 && sequence.musicStatus !== 'completed') {
      groups.push({
        category: 'music-prompt',
        label: 'Music prompt was not generated',
        shots: [],
      });
    }
  }

  // Mixed case: retryable failures + missing prompts → full retry wins
  if (
    requiresFullRetry &&
    groups.some((g) => g.category === 'image' || g.category === 'motion')
  ) {
    // Full retry re-runs everything including generation
  }

  // Catch-all: sequence failed but no specific failures identified
  if (sequence.status === 'failed' && groups.length === 0) {
    requiresFullRetry = true;
  }

  // Mid-pipeline crash (e.g. scene-split after streaming some shots, #1072):
  // later phases never ran, so the only "failures" are missing motion/music
  // prompts. That is not a real music-prompt failure — smart-retry would
  // mislead. Prefer the sequence statusError and force full regenerate.
  const onlyMissingDownstreamArtifacts =
    groups.length > 0 &&
    groups.every(
      (g) => g.category === 'music-prompt' || g.category === 'motion-prompts'
    );
  if (
    sequence.status === 'failed' &&
    sequence.statusError &&
    onlyMissingDownstreamArtifacts
  ) {
    return {
      requiresFullRetry: true,
      headline: 'Generation failed \u2014 full retry required',
      groups: [],
      totalFailures: 1,
      hasFailed: true,
      error: sequence.statusError,
    };
  }

  const totalFailures = groups.reduce(
    (sum, g) => sum + Math.max(g.shots.length, 1),
    0
  );

  const hasFailed = groups.length > 0 || sequence.status === 'failed';

  return {
    requiresFullRetry,
    headline: buildHeadline(groups, requiresFullRetry),
    groups,
    totalFailures,
    hasFailed,
    error: sequence.statusError,
  };
}
