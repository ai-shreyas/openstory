import { createFileRoute, redirect } from '@tanstack/react-router';

/** Theatre playback is now the nothing-selected canvas state (#986). */
export const Route = createFileRoute('/_app/sequences/$id/theatre')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/sequences/$id/scenes',
      params: { id: params.id },
    });
  },
  staticData: { breadcrumb: 'Theatre' },
});
