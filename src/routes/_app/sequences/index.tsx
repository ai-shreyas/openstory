import { SignInPrompt } from '@/components/auth/sign-in-prompt';
import { EvalView } from '@/components/eval/eval-view';
import { PageContainer } from '@/components/layout/page-container';
import { PageIntro } from '@/components/typography/page-intro';
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
    <>
      <PageIntro title="Your Sequences">
        Your films, from first draft to final cut.
      </PageIntro>
      <PageContainer
        maxWidth="full"
        padding="none"
        className="flex min-h-0 flex-1 flex-col overflow-hidden pb-4"
      >
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
    </>
  );
}
