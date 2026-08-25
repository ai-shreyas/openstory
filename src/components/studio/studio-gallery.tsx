import { AssetResult } from '@/components/schema-form/asset-result';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { AppImage } from '@/components/ui/app-image';
import {
  useDeleteStudioAsset,
  useToggleStudioFavorite,
} from '@/hooks/use-studio-assets';
import type { GeneratedAsset } from '@/lib/db/schema';
import {
  studioAspectRatio,
  studioPosterOutput,
  studioPrimaryOutput,
  studioPrompt,
} from '@/lib/studio/outputs';
import { cn } from '@/lib/utils';
import { Images, Star, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';

function aspectClass(asset: GeneratedAsset): string {
  const ratio = studioAspectRatio(asset);
  if (ratio === '9:16') return 'aspect-[9/16]';
  if (ratio === '1:1') return 'aspect-square';
  return 'aspect-video';
}

function StudioCard({
  asset,
  onOpen,
}: {
  asset: GeneratedAsset;
  onOpen: () => void;
}) {
  const favorite = useToggleStudioFavorite();
  const videoRef = useRef<HTMLVideoElement>(null);
  const primary = studioPrimaryOutput(asset);
  const poster = studioPosterOutput(asset);
  const prompt = studioPrompt(asset);
  const inFlight = asset.status === 'queued' || asset.status === 'running';
  const isVideo = primary?.contentType.startsWith('video/');

  return (
    <article className="group relative overflow-hidden rounded-lg border bg-muted">
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          'block w-full overflow-hidden text-left',
          aspectClass(asset)
        )}
        aria-label={prompt || 'Generated asset'}
      >
        {inFlight ? (
          <Skeleton className="h-full w-full rounded-none" />
        ) : asset.status === 'failed' ? (
          <div className="flex h-full items-center justify-center p-4 text-sm text-destructive">
            {asset.error ?? 'Generation failed'}
          </div>
        ) : isVideo && primary ? (
          <video
            ref={videoRef}
            src={primary.url}
            poster={poster?.url}
            muted
            playsInline
            loop
            className="h-full w-full object-cover"
            onMouseEnter={(event) => {
              if (window.matchMedia('(prefers-reduced-motion: reduce)').matches)
                return;
              void event.currentTarget.play();
            }}
            onMouseLeave={(event) => {
              event.currentTarget.pause();
              event.currentTarget.currentTime = 0;
            }}
          >
            <track kind="captions" />
          </video>
        ) : primary ? (
          <AppImage
            src={primary.url}
            alt={prompt || 'Generated image'}
            width={768}
            height={768}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No output
          </div>
        )}
      </button>
      <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-end p-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <Button
          type="button"
          size="icon"
          variant="secondary"
          className="pointer-events-auto"
          aria-label={asset.isFavorite ? 'Remove from favorites' : 'Favorite'}
          aria-pressed={asset.isFavorite}
          onClick={() =>
            favorite.mutate({
              id: asset.id,
              isFavorite: !asset.isFavorite,
            })
          }
        >
          <Star
            className={cn(asset.isFavorite && 'fill-current')}
            aria-hidden="true"
          />
        </Button>
      </div>
      {inFlight && (
        <p
          aria-live="polite"
          className="absolute inset-x-0 bottom-0 bg-background/80 px-2 py-1 text-xs text-muted-foreground"
        >
          {asset.status === 'queued' ? 'Queued…' : 'Generating…'}
        </p>
      )}
    </article>
  );
}

export function StudioGallery({
  assets,
  isLoading,
  isAuthenticated,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: {
  assets: GeneratedAsset[];
  isLoading: boolean;
  isAuthenticated: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const remove = useDeleteStudioAsset();
  const openAsset = assets.find((asset) => asset.id === openId);

  if (isLoading) {
    return (
      <div className="columns-2 gap-4 md:columns-3 lg:columns-4">
        {Array.from({ length: 8 }).map((_, index) => (
          <Skeleton
            key={index}
            className="mb-4 aspect-video w-full rounded-lg"
          />
        ))}
      </div>
    );
  }

  if (assets.length === 0) {
    return (
      <EmptyState
        icon={<Images className="h-12 w-12" />}
        title={isAuthenticated ? 'Nothing here yet' : 'Sign in to generate'}
        description={
          isAuthenticated
            ? 'Your stills and clips land here. Start with a prompt below.'
            : 'Browse the composer, then sign in to generate and keep a library.'
        }
      />
    );
  }

  return (
    <>
      <div className="columns-2 gap-4 md:columns-3 lg:columns-4">
        {assets.map((asset) => (
          <div key={asset.id} className="mb-4 break-inside-avoid">
            <StudioCard asset={asset} onOpen={() => setOpenId(asset.id)} />
          </div>
        ))}
      </div>
      {hasNextPage && (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            disabled={isFetchingNextPage}
            onClick={onLoadMore}
          >
            {isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}

      <Dialog
        open={openAsset != null}
        onOpenChange={(open) => {
          if (!open) setOpenId(null);
        }}
      >
        <DialogContent className="max-w-3xl">
          {openAsset && (
            <>
              <DialogHeader>
                <DialogTitle className="pr-8 text-base">
                  {studioPrompt(openAsset) || 'Generated asset'}
                </DialogTitle>
                <DialogDescription>
                  {openAsset.modelName} · {studioAspectRatio(openAsset)}
                </DialogDescription>
              </DialogHeader>
              <AssetResult asset={openAsset} />
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => {
                    remove.mutate(openAsset.id, {
                      onSuccess: () => setOpenId(null),
                    });
                  }}
                >
                  <Trash2 aria-hidden="true" />
                  Delete
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
