/**
 * Canvas / Script switch for the centre column (#1037).
 *
 * Both views share the spine, the inspector and the selection — this only
 * changes what the middle shows, so it reads as two views of one object rather
 * than two pages. That's the whole point: the script used to be a separate
 * route that took you out of Scenes.
 */

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { CanvasView } from '@/lib/scenes/scene-selection';
import { FileText, Film } from 'lucide-react';

type CanvasViewToggleProps = {
  view: CanvasView;
  onViewChange: (view: CanvasView) => void;
  /** Progressive reveal (#1091): the canvas has nothing to show until the
   *  first shot preview lands, so the item stays disabled during the split. */
  canvasDisabled?: boolean;
  /** View-scoped action shown at the right of the row. Absolutely positioned so
   *  it can't push the toggle off centre. */
  trailing?: React.ReactNode;
};

export const CanvasViewToggle: React.FC<CanvasViewToggleProps> = ({
  view,
  onViewChange,
  canvasDisabled,
  trailing,
}) => (
  <div className="relative flex shrink-0 items-center justify-center pt-4">
    <ToggleGroup
      type="single"
      value={view}
      // A toggle group fires `''` when the active item is re-clicked; ignore
      // that so the centre column can never end up showing nothing.
      onValueChange={(next) => {
        if (next === 'canvas' || next === 'script') onViewChange(next);
      }}
      variant="outline"
      size="sm"
    >
      <ToggleGroupItem
        value="canvas"
        aria-label="Show the canvas"
        disabled={canvasDisabled}
      >
        <Film className="mr-1.5 h-3.5 w-3.5" />
        Canvas
      </ToggleGroupItem>
      <ToggleGroupItem value="script" aria-label="Show the script">
        <FileText className="mr-1.5 h-3.5 w-3.5" />
        Script
      </ToggleGroupItem>
    </ToggleGroup>
    {trailing && (
      <div className="absolute right-4 top-4 flex items-center">{trailing}</div>
    )}
  </div>
);
