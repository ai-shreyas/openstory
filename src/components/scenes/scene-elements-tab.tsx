/**
 * Scene Elements Tab
 * Displays user-uploaded reference elements (logos, products) referenced in
 * the current shot by UPPERCASE token. Add / click-through to replace live
 * here — the standalone elements page was retired in #986.
 */

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { facetIdsForShots, useSceneFacetMaps } from '@/hooks/use-scene-facets';
import {
  useSequenceElements,
  useUploadElementToSequence,
} from '@/hooks/use-sequence-elements';
import type { SequenceElement } from '@/lib/db/schema';
import { MAX_SEQUENCE_ELEMENTS } from '@/lib/sequence-elements/limits';
import { Link } from '@tanstack/react-router';
import { ImagePlus, Loader2 } from 'lucide-react';
import { AppImage } from '@/components/ui/app-image';
import { useRef } from 'react';
import { toast } from 'sonner';

const ELEMENT_MENTION_HINT =
  'Type @ in a prompt or script to insert an element.';

type SceneElementsTabProps = {
  sequenceId: string;
  /** Shots in the current selection. `null` = whole sequence (show all). */
  shotIds: string[] | null;
};

const AddElementButton: React.FC<{
  sequenceId: string;
  currentCount: number;
}> = ({ sequenceId, currentCount }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const upload = useUploadElementToSequence();
  const remaining = MAX_SEQUENCE_ELEMENTS - currentCount;

  const handleFiles = (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (images.length === 0) return;
    const accepted = images.slice(0, Math.max(0, remaining));
    if (accepted.length === 0) {
      toast.error(`You can add up to ${MAX_SEQUENCE_ELEMENTS} elements`);
      return;
    }
    for (const file of accepted) {
      upload.mutate(
        { file, sequenceId },
        {
          onError: (err) => {
            toast.error(`Couldn't upload ${file.name}`, {
              description: err instanceof Error ? err.message : 'Upload failed',
            });
          },
        }
      );
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
        disabled={upload.isPending || remaining <= 0}
        onChange={(event) => {
          handleFiles(Array.from(event.target.files ?? []));
          event.target.value = '';
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={upload.isPending || remaining <= 0}
        onClick={() => inputRef.current?.click()}
        aria-label="Add element"
      >
        {upload.isPending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <ImagePlus className="size-3.5" />
        )}
        {upload.isPending ? 'Uploading…' : 'Add'}
      </Button>
    </>
  );
};

export const SceneElementsTab: React.FC<SceneElementsTabProps> = ({
  sequenceId,
  shotIds,
}) => {
  const { data: elements = [], isLoading } = useSequenceElements(sequenceId);
  const { data: facetMaps } = useSceneFacetMaps(sequenceId);

  const scopedIds = facetIdsForShots(facetMaps?.elementIdsByShot, shotIds);
  const sceneElements: SequenceElement[] =
    scopedIds === null ? elements : elements.filter((e) => scopedIds.has(e.id));

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="aspect-square rounded-lg" />
        ))}
      </div>
    );
  }

  const header = (
    <div className="flex items-start justify-between gap-3">
      <p className="text-xs text-muted-foreground">{ELEMENT_MENTION_HINT}</p>
      <AddElementButton
        sequenceId={sequenceId}
        currentCount={elements.length}
      />
    </div>
  );

  if (sceneElements.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <div className="rounded-full bg-muted p-4 mb-4">
            <ImagePlus className="h-8 w-8 text-muted-foreground/50" />
          </div>
          <p className="text-sm text-muted-foreground">
            {shotIds === null
              ? 'No elements yet'
              : 'No elements in this selection'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {header}
      <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
        <span>{shotIds === null ? 'All Elements' : 'Elements'}</span>
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
            to="/sequences/$id/elements/$elementId"
            params={{ id: sequenceId, elementId: el.id }}
            className="group relative block overflow-hidden rounded-lg bg-card"
          >
            <div className="relative aspect-square overflow-hidden bg-muted">
              <AppImage
                src={el.imageUrl}
                alt={el.token}
                width={160}
                height={160}
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
