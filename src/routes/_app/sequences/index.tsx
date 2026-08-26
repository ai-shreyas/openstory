import { SignInPrompt } from '@/components/auth/sign-in-prompt';
import { EvalView } from '@/components/eval/eval-view';
import { PageContainer } from '@/components/layout/page-container';
import { useSequencesListPrefs } from '@/hooks/use-sequences-list-prefs';
import { useUser } from '@/hooks/use-user';
import { sequencesListSearchSchema } from '@/lib/sequences/list-prefs';
import { createFileRoute } from '@tanstack/react-router';
import { Video } from 'lucide-react';

export const Route = createFileRoute('/_app/sequences/')({
  validateSearch: sequencesListSearchSchema,
  component: SequencesPage,
  staticData: { breadcrumb: 'Sequences' },
});

function SequencesPage() {
  const search = Route.useSearch();
  const { data: currentUser } = useUser();

  return (
    <PageContainer
      maxWidth="full"
      padding="compact"
      className="flex-1 flex flex-col overflow-hidden"
    >
      <h1 className="sr-only">Your Sequences</h1>
      {currentUser ? (
        <SequencesEvalView search={search} />
      ) : (
        <SignInPrompt
          icon={<Video className="h-12 w-12" />}
          title="Sign in to see your sequences"
          description="Your generated sequences live here once you create an account."
        />
      )}
    </PageContainer>
  );
}

function SequencesEvalView({
  search,
}: {
  search: ReturnType<typeof Route.useSearch>;
}) {
  const navigate = Route.useNavigate();
  const { prefs, setPrefs } = useSequencesListPrefs(search, navigate);

  return <EvalView search={search} prefs={prefs} setPrefs={setPrefs} />;
}
