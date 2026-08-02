import { StalenessIndicator } from '@/components/staleness/staleness-indicator';
import { Button } from '@/components/ui/button';
import {
  type ShotStaleness,
  shotIsStale,
  shotIsUpdating,
  shotStalenessUnknown,
} from '@/hooks/use-shot-staleness';
import type { ShotWithImage } from '@/lib/shots/shot-with-image';
import { Loader2 } from 'lucide-react';

type SceneStaleShotsProps = {
  /** The in-scope shots (a scene's, or the whole sequence's), in order. */
  shots: ShotWithImage[];
  /** Batched staleness for those shots, keyed by shot id (#1077). */
  staleness: Record<string, ShotStaleness> | undefined;
  /**
   * The staleness request failed. Without this, an errored request is
   * indistinguishable from a clean scene — both render nothing.
   */
  stalenessFailed?: boolean;
  /** Same handler the left rail uses — lands at shot scope. */
  onSelectShot: (shotId: string) => void;
  /** Regenerate every artifact that is stale right now across these shots. */
  onUpdateAll?: () => void;
  isUpdating?: boolean;
};

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
  stalenessFailed = false,
  onSelectShot,
  onUpdateAll,
  isUpdating = false,
}) => {
  // A shot whose comparison failed is reported the same way a failed request
  // is: we don't know, and saying nothing would read as "up to date".
  const uncheckable =
    stalenessFailed ||
    shots.some((shot) => shotStalenessUnknown(staleness?.[shot.id]));

  if (uncheckable) {
    return (
      <StalenessIndicator
        entityType="sequence"
        density="status-line"
        tone="unknown"
        message="Couldn’t check whether these shots are up to date"
      />
    );
  }

  const staleShots = shots.filter((shot) => shotIsStale(staleness?.[shot.id]));
  // Shots whose stale artifacts are all already covered by a live server-side
  // claim (#1085) — a run (this tab's or someone else's) is fixing them now.
  const updatingShots = shots.filter(
    (shot) =>
      !shotIsStale(staleness?.[shot.id]) && shotIsUpdating(staleness?.[shot.id])
  );
  if (staleShots.length === 0 && updatingShots.length === 0) return null;

  // Nothing actionable left: everything in flight, clicking would no-op
  // against the server-side dedup.
  const busy = isUpdating || staleShots.length === 0;

  return (
    <StalenessIndicator
      entityType="sequence"
      density="status-line"
      message={
        staleShots.length > 0
          ? 'Out of date since your edit'
          : 'Updating out-of-date shots…'
      }
      isRegenerating={busy}
      onRegenerate={staleShots.length > 0 ? onUpdateAll : undefined}
    >
      {[...staleShots, ...updatingShots].map((shot) => {
        const number = shot.shotNumber ?? shot.orderIndex + 1;
        const updating = updatingShots.includes(shot);
        return (
          <Button
            key={shot.id}
            type="button"
            variant="outline"
            size="sm"
            className="h-6 rounded-full px-2 text-xs font-normal"
            onClick={() => onSelectShot(shot.id)}
            aria-label={
              updating
                ? `Open shot ${number} — updating`
                : `Open shot ${number} — out of date`
            }
          >
            {updating && (
              <Loader2
                aria-hidden="true"
                className="mr-1 h-2.5 w-2.5 animate-spin motion-reduce:animate-none"
              />
            )}
            Shot {number}
          </Button>
        );
      })}
    </StalenessIndicator>
  );
};
