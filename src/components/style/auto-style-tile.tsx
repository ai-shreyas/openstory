import { cn } from '@/lib/utils';
import { Wand2 } from 'lucide-react';

type AutoStyleTileProps = {
  selected: boolean;
  disabled?: boolean;
  tabIndex: number;
  onSelect: () => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
};

/**
 * The "Automatic" slot in the composer strip (#1213): instead of a library
 * style, the storyboard run derives a style from the script itself.
 */
export function AutoStyleTile({
  selected,
  disabled = false,
  tabIndex,
  onSelect,
  onKeyDown,
}: AutoStyleTileProps) {
  return (
    <button
      type="button"
      data-style-tile
      onClick={onSelect}
      onKeyDown={onKeyDown}
      tabIndex={tabIndex}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        'relative aspect-square overflow-hidden rounded-lg border-2 whitespace-normal',
        'flex flex-col items-center justify-center gap-1 bg-muted/40',
        'transition-all duration-200 hover:scale-105 hover:shadow-lg',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-50',
        selected
          ? 'border-primary shadow-md scale-105 bg-primary/10'
          : 'border-dashed border-muted-foreground/30 hover:border-primary/50'
      )}
      aria-label="Automatic style: derive a style from the script"
      title="Derive a style from the script. It stays with this sequence until you add it to your library."
    >
      <Wand2 className="size-5 text-primary" aria-hidden />
      <span className="text-center text-xs font-medium">Automatic</span>
    </button>
  );
}
