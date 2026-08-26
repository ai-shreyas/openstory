import { SignInPrompt } from '@/components/auth/sign-in-prompt';
import { EvalView } from '@/components/eval/eval-view';
import { PageContainer } from '@/components/layout/page-container';
import { PageDescription } from '@/components/typography/page-description';
import { useUser } from '@/hooks/use-user';
import { createFileRoute } from '@tanstack/react-router';
import { Video } from 'lucide-react';
import { z } from 'zod';

const searchSchema = z.object({
  user: z.string().email().optional(),
});

export const Route = createFileRoute('/_app/sequences/')({
  validateSearch: searchSchema,
  component: SequencesPage,
  staticData: { breadcrumb: 'Sequences' },
});

function SequencesPage() {
  const { user } = Route.useSearch();
  const { data: currentUser } = useUser();

  return (
    <PageContainer
      maxWidth="full"
      padding="compact"
      className="flex-1 flex flex-col overflow-hidden"
    >
      <h1 className="sr-only">Your Sequences</h1>
      <PageDescription>
        Your films, from first draft to final cut.
      </PageDescription>
      {currentUser ? (
        <EvalView initialUserFilter={user} />
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
