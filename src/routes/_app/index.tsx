import { NewSequencePage } from '@/components/script/new-sequence-page';
import { createFileRoute } from '@tanstack/react-router';
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
 * visitors (actions still gate behind login). Lives under `_app` so it shares
 * AppLayout, session prefetch, and the app error boundary (#1104).
 */
export const Route = createFileRoute('/_app/')({
  validateSearch: searchSchema,
  component: HomePage,
});

function HomePage() {
  const search = Route.useSearch();
  return <NewSequencePage {...search} composerPath="/" />;
}
