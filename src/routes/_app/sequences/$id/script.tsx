import { ScriptView } from '@/components/script/script-view';
import { getScenesFn } from '@/functions/scenes';
import { sceneKeys } from '@/hooks/use-scenes';
import { useSequence } from '@/hooks/use-sequences';
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/sequences/$id/script')({
  component: ScriptPage,
  staticData: { breadcrumb: 'Script' },
  /**
   * Once a sequence is analysed its script lives in `scene_script_versions` and
   * is edited scene-by-scene in the Scenes script view (#1037). This page only
   * ever showed that composed document read-only, with a full re-analysis fork
   * as the sole way to change it — a dead end. So an analysed sequence is sent
   * to the editable surface; the page stays for the pre-analysis composer.
   *
   * Gate on `scenes` rows (not composed-script text): stream-time split writes
   * scenes before script versions are seeded (#1072), so composed text lags
   * and would leave this page up mid-analysis.
   */
  loader: async ({ params, context: { queryClient } }) => {
    const scenes = await queryClient.ensureQueryData({
      queryKey: sceneKeys.list(params.id),
      queryFn: () => getScenesFn({ data: { sequenceId: params.id } }),
    });
    if (scenes.length > 0) {
      throw redirect({
        to: '/sequences/$id/scenes',
        params: { id: params.id },
        search: { view: 'script' },
      });
    }
  },
});

function ScriptPage() {
  const { id: sequenceId } = Route.useParams();
  const navigate = useNavigate();

  const { data: sequence, isLoading: isLoadingSequence } =
    useSequence(sequenceId);

  const handleSuccess = (sequenceIds: string[]) => {
    const [firstId] = sequenceIds;
    if (firstId) {
      void navigate({
        to: '/sequences/$id/scenes',
        params: { id: firstId },
      });
    }
  };

  return (
    <div className="h-full px-6 py-4" data-testid="edit-script-page">
      <ScriptView
        onSuccess={handleSuccess}
        sequence={sequence}
        loading={isLoadingSequence || !sequence}
        flat
      />
    </div>
  );
}
