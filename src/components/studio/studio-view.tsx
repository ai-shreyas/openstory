import { StudioComposer } from '@/components/studio/studio-composer';
import { StudioGallery } from '@/components/studio/studio-gallery';
import { useAuthGate } from '@/components/auth/auth-gate-provider';
import { Button } from '@/components/ui/button';
import { PageContainer } from '@/components/layout/page-container';
import { PageDescription } from '@/components/typography/page-description';
import { PageHeader } from '@/components/typography/page-header';
import { useStudioAssets } from '@/hooks/use-studio-assets';
import type { StudioKindFilter, StudioSort } from '@/lib/studio/schema';
import { Link } from '@tanstack/react-router';
import { Star } from 'lucide-react';

type StudioViewProps = {
  kind: StudioKindFilter;
  sort: StudioSort;
  favorites: boolean;
};

export function StudioView({ kind, sort, favorites }: StudioViewProps) {
  const { isAuthenticated } = useAuthGate();
  const activity = kind === 'all' ? undefined : kind;
  const query = useStudioAssets({
    activity,
    favoritesOnly: favorites || undefined,
    order: sort,
  });

  const assets = query.data?.pages.flatMap((page) => page.assets) ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <PageContainer maxWidth="wide">
          <h1 className="sr-only">Images and Videos</h1>
          <PageHeader>
            <PageDescription>
              Generate a still or a clip from a prompt. Same models as
              sequences, kept in a library you can sort and favorite.
            </PageDescription>
          </PageHeader>

          <div className="flex flex-wrap items-center gap-2">
            <FilterLink
              label="All"
              kind="all"
              sort={sort}
              favorites={favorites}
              active={kind === 'all'}
            />
            <FilterLink
              label="Images"
              kind="image"
              sort={sort}
              favorites={favorites}
              active={kind === 'image'}
            />
            <FilterLink
              label="Videos"
              kind="video"
              sort={sort}
              favorites={favorites}
              active={kind === 'video'}
            />
            <FilterLink
              label="Favorites"
              kind={kind}
              sort={sort}
              favorites={!favorites}
              active={favorites}
              icon
            />
            <div className="ml-auto flex items-center gap-2">
              <FilterLink
                label="Newest"
                kind={kind}
                sort="newest"
                favorites={favorites}
                active={sort === 'newest'}
              />
              <FilterLink
                label="Oldest"
                kind={kind}
                sort="oldest"
                favorites={favorites}
                active={sort === 'oldest'}
              />
            </div>
          </div>

          <StudioGallery
            assets={assets}
            isLoading={query.isPending && isAuthenticated}
            isAuthenticated={isAuthenticated}
            hasNextPage={query.hasNextPage}
            isFetchingNextPage={query.isFetchingNextPage}
            onLoadMore={() => void query.fetchNextPage()}
          />
        </PageContainer>
      </div>

      <div className="shrink-0 border-t bg-background/80 backdrop-blur-md">
        <PageContainer maxWidth="wide" padding="compact" className="py-4">
          <StudioComposer
            defaultActivity={kind === 'video' ? 'video' : 'image'}
          />
        </PageContainer>
      </div>
    </div>
  );
}

function FilterLink({
  label,
  kind,
  sort,
  favorites,
  active,
  icon,
}: {
  label: string;
  kind: StudioKindFilter;
  sort: StudioSort;
  favorites: boolean;
  active: boolean;
  icon?: boolean;
}) {
  return (
    <Button asChild size="sm" variant={active ? 'default' : 'outline'}>
      <Link
        to="/studio"
        search={{
          kind: kind === 'all' ? undefined : kind,
          sort: sort === 'newest' ? undefined : sort,
          favorites: favorites ? true : undefined,
        }}
      >
        {icon && <Star className="size-4" aria-hidden="true" />}
        {label}
      </Link>
    </Button>
  );
}
