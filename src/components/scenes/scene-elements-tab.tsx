/**
 * Scene Elements Tab
 * Displays user-uploaded reference elements (logos, products) referenced in
 * the current shot by UPPERCASE token.
 */

import { Skeleton } from '@/components/ui/skeleton';
import { useSequenceElements } from '@/hooks/use-sequence-elements';
import type { SequenceElement } from '@/lib/db/schema';
import type { SelectionTags } from '@/lib/scenes/scene-selection';
import { matchElementsToScene } from '@/lib/workflows/scene-matching';
import { Link } from '@tanstack/react-router';
import { ImagePlus, Loader2 } from 'lucide-react';

type SceneElementsTabProps = {
  sequenceId: string;
  /** `null` = whole sequence (show all elements). */
  tags: SelectionTags | null;
};

export const SceneElementsTab: React.FC<SceneElementsTabProps> = ({
  sequenceId,
  tags,
}) => {
  const { data: elements = [], isLoading } = useSequenceElements(sequenceId);

  const elementTags = tags?.elementTags ?? [];
  const sceneScript = tags?.scriptExtracts.join('\n') ?? '';

  const sceneElements: SequenceElement[] =
    tags === null
      ? elements
      : matchElementsToScene(elements, elementTags, sceneScript);

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="aspect-square rounded-lg" />
        ))}
      </div>
    );
  }

  if (sceneElements.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="rounded-full bg-muted p-4 mb-4">
          <ImagePlus className="h-8 w-8 text-muted-foreground/50" />
        </div>
        <p className="text-sm text-muted-foreground">
          {tags === null ? 'No elements yet' : 'No elements in this selection'}
        </p>
        {elementTags.length > 0 && (
          <p className="mt-2 text-xs text-muted-foreground/70">
            Looking for: {elementTags.join(', ')}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
        <span>{tags === null ? 'All Elements' : 'Elements'}</span>
        <span className="text-muted-foreground/50">·</span>
        <span>
          {sceneElements.length} reference
          {sceneElements.length > 1 ? 's' : ''}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {sceneElements.map((el) => (
          <Link
            key={el.id}
            to="/sequences/$id/elements"
            params={{ id: sequenceId }}
            className="group relative block overflow-hidden rounded-lg bg-card"
          >
            <div className="relative aspect-square overflow-hidden bg-muted">
              <img
                src={el.imageUrl}
                alt={el.token}
                className="h-full w-full object-contain transition-transform duration-500 group-hover:scale-105"
              />
              <div className="absolute inset-x-0 bottom-0 bg-linear-to-t from-black/80 via-black/20 to-transparent p-3">
                <span className="font-mono text-xs font-semibold tracking-wider text-white">
                  {el.token}
                </span>
              </div>
            </div>
            {el.description && (
              <div className="border-t border-border/50 p-3">
                <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                  {el.description}
                </p>
              </div>
            )}
            {el.visionStatus === 'pending' ||
            el.visionStatus === 'analyzing' ? (
              <div className="absolute top-2 right-2 flex items-center gap-1 rounded bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground backdrop-blur-sm">
                <Loader2 className="size-2.5 animate-spin" />
                Analyzing
              </div>
            ) : null}
          </Link>
        ))}
      </div>
    </div>
  );
};
