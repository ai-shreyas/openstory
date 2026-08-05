import { NewSequencePage } from '@/components/script/new-sequence-page';
import { sessionQueryOptions } from '@/lib/auth/session-query';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { z } from 'zod';

// `style` carries a sample style's slug from the showcase/gallery "Try this
// style" links (#956); the composer seeds its brief + selects the style.
// `prefill=style` narrows that to style-only — select the style but leave the
// prompt blank (the styles page "Use this style" CTA). Optional, no default —
// a bare `/` must stay a bare URL (no 307 rewrite).
// `from` carries a source sequence id — the "Generate Copy" entry point (#1037).
const searchSchema = z.object({
  style: z.string().optional(),
  prefill: z.enum(['style']).optional(),
  from: z.string().optional(),
});

/**
 * App home at `/`. Same composer as `/sequences/new`, open to anonymous
 * visitors (actions still gate behind login). Rendered in the app shell via
 * `_marketing` layout for the root path only (#1104).
 */
export const Route = createFileRoute('/_marketing/')({
  validateSearch: searchSchema,
  beforeLoad: async ({ context: { queryClient } }) => {
    // Prefetch session so useUser is settled on first paint (mirrors _app).
    const session = await queryClient.ensureQueryData(sessionQueryOptions);
    if (session?.user.status === 'suspended') {
      throw redirect({ to: '/login' });
    }
  },
  component: HomePage,
});

function HomePage() {
  const search = Route.useSearch();
  return <NewSequencePage {...search} composerPath="/" />;
}
