/**
 * "What a film really costs" examples for the public pricing page (#1140).
 *
 * Built from the same estimators the credit gate uses, so marketing numbers
 * cannot drift from pre-flight. Returns null when the default image model has
 * no honest pricing signal — never invent a showcase total from the $0.10 floor.
 */

import type { EffectiveFalPricing } from '@/lib/ai/fal-pricing-live';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MUSIC_MODEL,
  DEFAULT_VIDEO_MODEL,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
  AUDIO_MODELS,
} from '@/lib/ai/models';
import { DEFAULT_ASPECT_RATIO } from '@/lib/constants/aspect-ratios';
import {
  estimateImageCost,
  estimateStoryboardCost,
} from '@/lib/billing/cost-estimation';
import { microsToDisplayUsd, type Microdollars } from '@/lib/billing/money';
import { SIGNUP_GRANT_MICROS } from '@/lib/billing/constants';

const TYPICAL_SCENE_COUNT = 8;
const TYPICAL_SHOT_DURATION_S = 5;

type FilmCostExample = {
  id: string;
  title: string;
  description: string;
  /** Formatted total, e.g. "~$2.40". */
  cost: string;
  /** Bullet-level breakdown of what is included. */
  breakdown: string[];
  /** Raw micros for tests / comparisons. */
  costMicros: Microdollars;
};

export type FilmCostExamples = {
  examples: FilmCostExample[];
  /** e.g. "$10.00" — welcome grant callout. */
  welcomeCredits: string;
  imageModelName: string;
  videoModelName: string;
  audioModelName: string;
};

function formatEstimate(micros: Microdollars): string {
  return `~${microsToDisplayUsd(micros)}`;
}

/**
 * Three tiers: images-only first sequence, motion short, motion + music.
 * All use product defaults so the welcome-grant comparison stays honest.
 */
export function buildFilmCostExamples(
  pricing: Record<string, EffectiveFalPricing>
): FilmCostExamples | null {
  // Without an honest default-image signal the showcase would either lie
  // (floor) or be empty — prefer hiding the section until pricing is loaded.
  const sampleImage = estimateImageCost(
    DEFAULT_IMAGE_MODEL,
    DEFAULT_ASPECT_RATIO,
    1,
    { pricing }
  );
  if (sampleImage === null) return null;

  const imagesOnly = estimateStoryboardCost({
    imageModel: DEFAULT_IMAGE_MODEL,
    aspectRatio: DEFAULT_ASPECT_RATIO,
    estimatedSceneCount: TYPICAL_SCENE_COUNT,
    autoGenerateMotion: false,
    autoGenerateMusic: false,
    pricing,
  });

  const withMotion = estimateStoryboardCost({
    imageModel: DEFAULT_IMAGE_MODEL,
    aspectRatio: DEFAULT_ASPECT_RATIO,
    estimatedSceneCount: TYPICAL_SCENE_COUNT,
    autoGenerateMotion: true,
    videoModels: [DEFAULT_VIDEO_MODEL],
    videoDurationSeconds: TYPICAL_SHOT_DURATION_S,
    autoGenerateMusic: false,
    pricing,
  });

  const withMotionAndMusic = estimateStoryboardCost({
    imageModel: DEFAULT_IMAGE_MODEL,
    aspectRatio: DEFAULT_ASPECT_RATIO,
    estimatedSceneCount: TYPICAL_SCENE_COUNT,
    autoGenerateMotion: true,
    videoModels: [DEFAULT_VIDEO_MODEL],
    videoDurationSeconds: TYPICAL_SHOT_DURATION_S,
    autoGenerateMusic: true,
    audioModels: [DEFAULT_MUSIC_MODEL],
    audioDurationSeconds: TYPICAL_SCENE_COUNT * TYPICAL_SHOT_DURATION_S,
    pricing,
  });

  const imageName = IMAGE_MODELS[DEFAULT_IMAGE_MODEL].name;
  const videoName = IMAGE_TO_VIDEO_MODELS[DEFAULT_VIDEO_MODEL].name;
  const audioName = AUDIO_MODELS[DEFAULT_MUSIC_MODEL].name;

  return {
    welcomeCredits: microsToDisplayUsd(SIGNUP_GRANT_MICROS),
    imageModelName: imageName,
    videoModelName: videoName,
    audioModelName: audioName,
    examples: [
      {
        id: 'images-only',
        title: 'First sequence — stills',
        description: `About ${TYPICAL_SCENE_COUNT} scenes as still images with script analysis, cast, and locations. Motion and music off.`,
        cost: formatEstimate(imagesOnly),
        costMicros: imagesOnly,
        breakdown: [
          `Script analysis + character & location sheets`,
          `${TYPICAL_SCENE_COUNT} shot images (${imageName})`,
          `No motion or music`,
        ],
      },
      {
        id: 'with-motion',
        title: 'Short film — stills + motion',
        description: `Same storyboard, plus ~${TYPICAL_SHOT_DURATION_S}s of motion video per shot.`,
        cost: formatEstimate(withMotion),
        costMicros: withMotion,
        breakdown: [
          `Everything in “stills”`,
          `${TYPICAL_SCENE_COUNT} × ~${TYPICAL_SHOT_DURATION_S}s motion (${videoName})`,
        ],
      },
      {
        id: 'with-motion-music',
        title: 'Polished short — motion + music',
        description:
          'Full pipeline: stills, per-shot motion, and one soundtrack for the sequence.',
        cost: formatEstimate(withMotionAndMusic),
        costMicros: withMotionAndMusic,
        breakdown: [
          `Everything in “stills + motion”`,
          `One music track (${audioName})`,
        ],
      },
    ],
  };
}
