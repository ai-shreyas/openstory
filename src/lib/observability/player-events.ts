/**
 * Client-side playback events so "play did nothing" is measurable without
 * session replays (#1284).
 *
 * Failures must never break play — every helper no-ops if posthog is missing.
 */

export type VideoPlaySource = 'canvas' | 'theatre' | 'modal';

export type PlayerCapture =
  | {
      capture: (event: string, properties?: Record<string, unknown>) => void;
    }
  | null
  | undefined;

export type VideoPlayProperties = {
  source: VideoPlaySource;
  sequence_id?: string;
  shot_id?: string;
};

export type VideoPlayFailedProperties = {
  source: VideoPlaySource;
  reason: string;
  sequence_id?: string;
  shot_id?: string;
};

export type SequenceReadySeenProperties = {
  sequence_id: string;
  scene_count: number;
};

export function captureVideoPlay(
  posthog: PlayerCapture,
  properties: VideoPlayProperties
): void {
  posthog?.capture('video_play', properties);
}

export function captureVideoPlayFailed(
  posthog: PlayerCapture,
  properties: VideoPlayFailedProperties
): void {
  posthog?.capture('video_play_failed', properties);
}

export function captureSequenceReadySeen(
  posthog: PlayerCapture,
  properties: SequenceReadySeenProperties
): void {
  posthog?.capture('sequence_ready_seen', properties);
}
