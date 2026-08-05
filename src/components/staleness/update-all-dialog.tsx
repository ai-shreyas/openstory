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
import { cn } from '@/lib/utils';
import { useState } from 'react';

type UpdateAllDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Confirm with the chosen cascade depth; the dialog closes itself. */
  onConfirm: (depth: UpdateStaleDepth) => void;
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
}) => {
  // 'images' is the middle-ground default — the closest match to what
  // "Update all" did before depths existed.
  const [depth, setDepth] = useState<UpdateStaleDepth>('images');

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Update out-of-date items</AlertDialogTitle>
          <AlertDialogDescription>
            Choose how deep the update goes. Only items that are already out of
            date (or become out of date from this update) are regenerated —
            nothing is ever created for the first time.
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
