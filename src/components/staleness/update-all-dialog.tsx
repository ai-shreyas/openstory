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
import {
  UPDATE_STALE_DEPTH_DESCRIPTIONS,
  UPDATE_STALE_DEPTH_LABELS,
  UPDATE_STALE_DEPTHS,
  type UpdateStaleDepth,
} from '@/lib/shots/update-stale-depth';
import type { ShotArtifact, ShotStaleness } from '@/hooks/use-shot-staleness';
import { cn } from '@/lib/utils';
import { useState } from 'react';

type UpdateAllDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Confirm with the chosen cascade depth; the dialog closes itself. */
  onConfirm: (depth: UpdateStaleDepth) => void;
  /**
   * Staleness of each out-of-date shot in scope (#1194) — drives the "what
   * changed" summary so the depth question has a reason attached.
   */
  staleShots: ShotStaleness[];
};

const ARTIFACT_LABELS: [ShotArtifact, string][] = [
  ['visualPrompt', 'visual prompt'],
  ['motionPrompt', 'motion prompt'],
  ['thumbnail', 'image'],
];

/**
 * "3 shots have an out-of-date visual prompt, motion prompt and image".
 * Staleness is hash-based — we know WHICH artifacts diverged from their
 * inputs, not which edit did it — so this names the artifacts and the input
 * surface (script, style, characters, locations, shot settings) instead of
 * guessing at the edit.
 */
export const describeStaleShots = (staleShots: ShotStaleness[]): string => {
  const parts = ARTIFACT_LABELS.filter(([a]) =>
    staleShots.some((s) => s[a] === 'stale')
  ).map(([, label]) => label);
  const list =
    parts.length > 1
      ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
      : (parts[0] ?? 'artifacts');
  const n = staleShots.length;
  return n === 1
    ? `This shot has an out-of-date ${list}.`
    : `${n} shots have an out-of-date ${list}.`;
};

/**
 * "Update all" depth confirmation (#1085). One dialog per trigger site
 * (shot status line, scene/sequence summary): pick how deep the update
 * cascades — prompts → images → videos → music — then confirm. A dialog
 * rather than a menu so each level's cost consequence is readable before
 * anything is billed. Native radios for keyboard/AT semantics.
 */
export const UpdateAllDialog: React.FC<UpdateAllDialogProps> = ({
  open,
  onOpenChange,
  onConfirm,
  staleShots,
}) => {
  // 'images' is the middle-ground default — the closest match to what
  // "Update all" did before depths existed.
  const [depth, setDepth] = useState<UpdateStaleDepth>('images');

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Update out-of-date items</AlertDialogTitle>
          <AlertDialogDescription className="flex flex-col gap-2">
            <span>
              {describeStaleShots(staleShots)} Something they were generated
              from — the script, style, characters, locations or shot settings —
              has changed since, so they no longer match your current project.
            </span>
            <span>
              Regenerating costs credits, and each level depends on the one
              before it, so choose how far the update goes. Only items that are
              already out of date (or become out of date from this update) are
              regenerated — nothing is created for the first time.
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Update depth</legend>
          {UPDATE_STALE_DEPTHS.map((option) => (
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
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-medium">
                  {UPDATE_STALE_DEPTH_LABELS[option]}
                </span>
                <span className="text-xs text-muted-foreground">
                  {UPDATE_STALE_DEPTH_DESCRIPTIONS[option]}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => onConfirm(depth)}>
            Update
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
