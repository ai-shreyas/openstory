import { Button } from '@/components/ui/button';
import type { ShotStaleness } from '@/hooks/use-shot-staleness';
import type { ShotWithImage } from '@/lib/shots/shot-with-image';

type SceneStaleShotsProps = {
  /** The selected scene's shots, in order. */
  shots: ShotWithImage[];
  /** Batched staleness for those shots, keyed by shot id (#1077). */
  staleness: Record<string, ShotStaleness> | undefined;
  /** Same handler the left rail uses — lands at shot scope. */
  onSelectShot: (shotId: string) => void;
};

export const shotIsStale = (staleness: ShotStaleness | undefined): boolean =>
  !!staleness &&
  (staleness.visualPrompt === 'stale' ||
    staleness.motionPrompt === 'stale' ||
    staleness.thumbnail === 'stale');

/**
 * Scene-scope staleness summary (#1077): one quiet line ending in clickable
 * shot-number chips that navigate down to shot scope, where the inline
 * regenerate controls live. A single line — no thumbnails — so it can't read
 * as content or compete with the reference imagery below. Renders nothing
 * while everything is fresh — no permanent strip.
 */
export const SceneStaleShots: React.FC<SceneStaleShotsProps> = ({
  shots,
  staleness,
  onSelectShot,
}) => {
  const staleShots = shots.filter((shot) => shotIsStale(staleness?.[shot.id]));
  if (staleShots.length === 0) return null;

  return (
    <div
      data-testid="scene-stale-shots"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
    >
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full bg-amber-500"
      />
      <span>Out of date since your edit</span>
      <span aria-hidden="true">·</span>
      {staleShots.map((shot) => {
        const number = shot.shotNumber ?? shot.orderIndex + 1;
        return (
          <Button
            key={shot.id}
            type="button"
            variant="outline"
            size="sm"
            className="h-5 rounded-full px-2 text-xs font-normal"
            onClick={() => onSelectShot(shot.id)}
            aria-label={`Open shot ${number} — out of date`}
          >
            Shot {number}
          </Button>
        );
      })}
    </div>
  );
};
