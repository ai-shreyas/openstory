import { createFileRoute, redirect } from '@tanstack/react-router';

/** Music index is now the nothing-selected Music facet (#986). */
export const Route = createFileRoute('/_app/sequences/$id/music')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/sequences/$id/scenes',
      params: { id: params.id },
      search: { facet: 'music' },
    });
  },
  staticData: { breadcrumb: 'Music' },
});
