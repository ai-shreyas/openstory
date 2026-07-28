import { StalenessIndicator } from '@/components/staleness/staleness-indicator';
import type { ShotStaleness } from '@/hooks/use-shot-staleness';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import type { ShotWithImage } from '@/lib/shots/shot-with-image';
import { SceneThumbnail } from './scene-thumbnail';

type SceneStaleShotsProps = {
  /** The selected scene's shots, in order. */
  shots: ShotWithImage[];
  /** Batched staleness for those shots, keyed by shot id (#1077). */
  staleness: Record<string, ShotStaleness> | undefined;
  aspectRatio?: AspectRatio;
  /** Same handler the left rail uses — lands at shot scope. */
  onSelectShot: (shotId: string) => void;
};

export const shotIsStale = (staleness: ShotStaleness | undefined): boolean =>
  !!staleness &&
  (staleness.visualPrompt === 'stale' ||
    staleness.motionPrompt === 'stale' ||
    staleness.thumbnail === 'stale');

/**
 * Scene-scope staleness summary (#1077): one quiet status line plus a row of
 * small clickable thumbnails for the shots a script edit outdated. Clicking a
 * thumbnail navigates down to shot scope, where the inline regenerate
 * controls live. Renders nothing while everything is fresh — no permanent
 * strip.
 */
export const SceneStaleShots: React.FC<SceneStaleShotsProps> = ({
  shots,
  staleness,
  aspectRatio,
  onSelectShot,
}) => {
  const staleShots = shots.filter((shot) => shotIsStale(staleness?.[shot.id]));
  if (staleShots.length === 0) return null;

  return (
    <div data-testid="scene-stale-shots" className="flex flex-col gap-2">
      <StalenessIndicator
        artifact="visual-prompt"
        entityType="shot"
        density="status-line"
        message={
          staleShots.length === 1
            ? '1 shot out of date since your last edit'
            : `${staleShots.length} shots out of date since your last edit`
        }
      />
      <div className="flex flex-wrap gap-2">
        {staleShots.map((shot) => {
          const number = shot.shotNumber ?? shot.orderIndex + 1;
          return (
            <button
              key={shot.id}
              type="button"
              onClick={() => onSelectShot(shot.id)}
              aria-label={`Open shot ${number} — out of date`}
              className="relative w-16 shrink-0 cursor-pointer overflow-hidden rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <SceneThumbnail
                thumbnailUrl={shot.thumbnailUrl}
                previewThumbnailUrl={shot.previewThumbnailUrl}
                thumbnailStatus={shot.thumbnailStatus || undefined}
                alt={`Shot ${number}`}
                aspectRatio={aspectRatio ?? '16:9'}
                className="w-full"
              />
              <span
                aria-hidden="true"
                className="absolute top-1 right-1 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-amber-500/30"
              />
            </button>
          );
        })}
      </div>
    </div>
  );
};
