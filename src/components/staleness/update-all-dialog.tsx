import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { getUpdateStalePreviewFn } from '@/functions/shots';
import type { ShotStaleness } from '@/hooks/use-shot-staleness';
import { useShowCosts } from '@/hooks/use-show-costs';
import { microsToDisplayUsd, type Microdollars } from '@/lib/billing/money';
import type { UpdateStalePreview } from '@/lib/shots/update-stale-preview';
import {
  UPDATE_STALE_DEPTH_LABELS,
  UPDATE_STALE_DEPTHS,
  type UpdateStaleDepth,
} from '@/lib/shots/update-stale-depth';
import { cn } from '@/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

type UpdateAllScope = {
  sequenceId: string;
  sceneId?: string;
  shotId?: string;
};

type UpdateAllDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Confirm with the chosen cascade depth; the dialog closes itself. */
  onConfirm: (depth: UpdateStaleDepth) => void;
  /** Staleness of each out-of-date shot in scope — supplies the causes (#1194). */
  staleShots: ShotStaleness[];
  /** What the dry-run preview plans over (shot / scene / sequence). */
  scope: UpdateAllScope;
  /** In-scope display numbers, for "shots 2, 3 & 4" labels. */
  shotNumberById?: ReadonlyMap<string, number>;
};

/** "Changed: Script, Character "Woman"" — deduped across shots, or null. */
export const describeCauses = (staleShots: ShotStaleness[]): string | null => {
  const causes = [...new Set(staleShots.flatMap((s) => s.causes))];
  return causes.length > 0 ? `Changed: ${causes.join(', ')}` : null;
};

/** "shot 2" / "shots 2, 3 & 4" / "this shot" at shot scope. */
export const shotsLabel = (
  shotIds: string[],
  numberById: ReadonlyMap<string, number> | undefined,
  singleShotScope: boolean
): string => {
  if (singleShotScope) return 'this shot';
  const numbers = shotIds
    .map((id) => numberById?.get(id))
    .filter((n): n is number => n != null)
    .sort((a, b) => a - b);
  if (numbers.length === 0) return `${shotIds.length} shots`;
  if (numbers.length === 1) return `shot ${numbers[0]}`;
  return `shots ${numbers.slice(0, -1).join(', ')} & ${numbers[numbers.length - 1]}`;
};

/**
 * What each depth level actually does, from the dry-run preview — only the
 * level's own additions (levels are cumulative and read top-down).
 */
export const describeLevel = (
  depth: UpdateStaleDepth,
  preview: UpdateStalePreview,
  numberById: ReadonlyMap<string, number> | undefined,
  singleShotScope: boolean
): string => {
  const label = (ids: string[]) => shotsLabel(ids, numberById, singleShotScope);
  switch (depth) {
    case 'prompts': {
      const parts: string[] = [];
      if (preview.visualPromptShotIds.length > 0)
        parts.push(`Image prompts for ${label(preview.visualPromptShotIds)}`);
      if (preview.motionPromptShotIds.length > 0)
        parts.push(`Motion prompts for ${label(preview.motionPromptShotIds)}`);
      return parts.length > 0 ? parts.join(' · ') : 'No prompts out of date';
    }
    case 'images':
      return preview.imageShotIds.length > 0
        ? `+ Images for ${label(preview.imageShotIds)}`
        : '+ No images affected';
    case 'video':
      return preview.videoShotIds.length > 0
        ? `+ Videos for ${label(preview.videoShotIds)}`
        : '+ No videos affected';
    case 'music':
      return preview.musicTrack
        ? '+ Music prompt and track'
        : preview.musicPrompt
          ? '+ Music prompt'
          : '+ No music changes';
  }
};

const costLabel = (cost: Microdollars | null | undefined): string | null =>
  cost == null ? null : `~${microsToDisplayUsd(cost)}`;

/**
 * "Update all" depth confirmation (#1085). Leads with WHAT changed, then the
 * computed cascade — which artifacts on which shots regenerate at each depth,
 * with the cumulative cost estimate — from a server dry-run of the same plan
 * the workflow freezes (#1194). Native radios for keyboard/AT semantics.
 */
export const UpdateAllDialog: React.FC<UpdateAllDialogProps> = ({
  open,
  onOpenChange,
  onConfirm,
  staleShots,
  scope,
  shotNumberById,
}) => {
  // 'images' is the middle-ground default — the closest match to what
  // "Update all" did before depths existed.
  const [depth, setDepth] = useState<UpdateStaleDepth>('images');
  const { showCosts } = useShowCosts();
  const singleShotScope = scope.shotId != null;

  const { data: preview } = useQuery({
    queryKey: [
      'update-stale-preview',
      scope.sequenceId,
      scope.sceneId,
      scope.shotId,
    ],
    queryFn: () => getUpdateStalePreviewFn({ data: scope }),
    enabled: open && scope.sequenceId !== '',
    staleTime: 30_000,
  });

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Update out-of-date items</AlertDialogTitle>
          <AlertDialogDescription className="flex flex-col gap-1">
            <span className="text-foreground">
              {describeCauses(staleShots) ??
                'Inputs changed since these were generated.'}
            </span>
            <span>Regenerate:</span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Update depth</legend>
          {UPDATE_STALE_DEPTHS.map((option) => {
            const cost = showCosts
              ? costLabel(preview?.costByDepth[option])
              : null;
            return (
              <label
                key={option}
                htmlFor={`update-all-depth-${option}`}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors',
                  'has-focus-visible:ring-[3px] has-focus-visible:ring-ring/50',
                  depth === option
                    ? 'border-primary/40 bg-primary/5'
                    : 'hover:bg-muted/50'
                )}
              >
                <input
                  id={`update-all-depth-${option}`}
                  type="radio"
                  name="update-all-depth"
                  value={option}
                  checked={depth === option}
                  onChange={() => setDepth(option)}
                  aria-label={UPDATE_STALE_DEPTH_LABELS[option]}
                  className="mt-1 accent-primary"
                />
                <span className="flex min-w-0 grow flex-col gap-0.5">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium">
                      {UPDATE_STALE_DEPTH_LABELS[option]}
                    </span>
                    {cost && (
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {cost}
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {preview
                      ? describeLevel(
                          option,
                          preview,
                          shotNumberById,
                          singleShotScope
                        )
                      : '…'}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => onConfirm(depth)}>
            {showCosts && preview?.costByDepth[depth] != null
              ? `Update · ~${microsToDisplayUsd(preview.costByDepth[depth])}`
              : 'Update'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
