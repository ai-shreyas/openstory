import { ScenesView } from '@/components/scenes/scenes-view';
import { scenesSearchSchema } from '@/lib/scenes/scene-selection';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/sequences/$id/scenes')({
  component: ScenesPage,
  validateSearch: scenesSearchSchema,
  staticData: { breadcrumb: 'Scenes' },
});

function ScenesPage() {
  const { id: sequenceId } = Route.useParams();
  const search = Route.useSearch();

  return <ScenesView sequenceId={sequenceId} search={search} />;
}
