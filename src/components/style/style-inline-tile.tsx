import { AppImage } from '@/components/ui/app-image';
import type { Style } from '@/lib/db/schema/libraries';
import { cn } from '@/lib/utils';
import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { getStyleGradient } from './style-gradient';

const StyleTileBackground: React.FC<{ style: Style }> = ({ style }) => {
  const [imgError, setImgError] = useState(false);

  return style.previewUrl && !imgError ? (
    <AppImage
      key={style.id}
      src={style.previewUrl}
      layout="fullWidth"
      alt={style.name}
      className="h-full w-full object-cover"
      onError={() => setImgError(true)}
    />
  ) : (
    <div
      className="h-full w-full"
      style={{
        background: getStyleGradient(style.config.colorPalette),
      }}
    />
  );
};

type StyleInlineTileProps = {
  style: Style;
  selected: boolean;
  disabled?: boolean;
  reasoning?: string;
  recommended?: boolean;
  tabIndex: number;
  onSelect: (styleId: string) => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
};

export function StyleInlineTile({
  style,
  selected,
  disabled = false,
  reasoning,
  recommended = false,
  tabIndex,
  onSelect,
  onKeyDown,
}: StyleInlineTileProps) {
  return (
    <button
      type="button"
      data-style-tile
      onClick={() => onSelect(style.id)}
      onKeyDown={onKeyDown}
      tabIndex={tabIndex}
      disabled={disabled}
      className={cn(
        'group relative aspect-square overflow-hidden rounded-lg border-2',
        'transition-all duration-200 hover:scale-105 hover:shadow-lg',
        'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-50',
        selected
          ? 'border-primary shadow-md scale-105'
          : 'border-transparent hover:border-primary/50'
      )}
      aria-label={`Select ${style.name} style`}
      title={reasoning}
    >
      <StyleTileBackground style={style} />
      {recommended && (
        <span
          aria-hidden
          className="absolute left-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm"
        >
          <Sparkles className="size-3" />
        </span>
      )}
      <div className="absolute inset-x-0 bottom-0 bg-linear-to-t from-black/80 via-black/60 to-transparent p-2">
        <p className="line-clamp-2 text-center text-xs font-medium text-white">
          {style.name}
        </p>
      </div>
      {selected && (
        <div className="pointer-events-none absolute inset-0 bg-primary/10" />
      )}
    </button>
  );
}
