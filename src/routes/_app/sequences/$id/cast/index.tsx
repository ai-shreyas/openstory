import { createFileRoute, redirect } from '@tanstack/react-router';

/** Cast index is now the nothing-selected Cast facet (#986). */
export const Route = createFileRoute('/_app/sequences/$id/cast/')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/sequences/$id/scenes',
      params: { id: params.id },
      search: { facet: 'cast' },
    });
  },
  staticData: { breadcrumb: 'Cast' },
});
