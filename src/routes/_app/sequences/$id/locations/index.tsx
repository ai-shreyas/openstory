import { createFileRoute, redirect } from '@tanstack/react-router';

/** Locations index is now the nothing-selected Locations facet (#986). */
export const Route = createFileRoute('/_app/sequences/$id/locations/')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/sequences/$id/scenes',
      params: { id: params.id },
      search: { facet: 'location' },
    });
  },
  staticData: { breadcrumb: 'Locations' },
});
