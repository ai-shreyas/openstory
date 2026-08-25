import { StudioView } from '@/components/studio/studio-view';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

const searchParamsSchema = z.object({
  kind: z.enum(['all', 'image', 'video']).optional(),
  sort: z.enum(['newest', 'oldest']).optional(),
  favorites: z.boolean().optional(),
});

export const Route = createFileRoute('/_app/studio/')({
  validateSearch: searchParamsSchema,
  component: StudioPage,
  staticData: { breadcrumb: 'Images and Videos' },
});

function StudioPage() {
  const {
    kind = 'all',
    sort = 'newest',
    favorites = false,
  } = Route.useSearch();
  return <StudioView kind={kind} sort={sort} favorites={favorites} />;
}
