import { BillingGateDialog } from '@/components/billing/billing-gate-dialog';
import { OpenStoryLogo } from '@/components/icons/openstory-logo';
import { PageContainer } from '@/components/layout/page-container';
import { ScriptView } from '@/components/script/script-view';
import { SampleVideoShowcase } from '@/components/style/sample-video-showcase';
import { Skeleton } from '@/components/ui/skeleton';
import { useBillingGate } from '@/hooks/use-billing-gate';
import { useSequence } from '@/hooks/use-sequences';
import { useStyles } from '@/hooks/use-styles';
import { useUser } from '@/hooks/use-user';
import { briefForStyle } from '@/lib/style/brief-for-style';
import { styleSlug } from '@/lib/style/style-slug';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';

const BILLING_PROMPT_KEY = 'openstory:billing-prompt-dismissed';
const BILLING_PROMPT_EXPIRY_DAYS = 1;

function wasBillingPromptDismissed(): boolean {
  if (typeof window === 'undefined') return false;
  const raw = localStorage.getItem(BILLING_PROMPT_KEY);
  if (!raw) return false;
  const expiry = Number(raw);
  if (Date.now() > expiry) {
    localStorage.removeItem(BILLING_PROMPT_KEY);
    return false;
  }
  return true;
}

function dismissBillingPrompt() {
  const expiry = Date.now() + BILLING_PROMPT_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  localStorage.setItem(BILLING_PROMPT_KEY, String(expiry));
}

// `style` carries a sample style's slug from the showcase/gallery "Try this
// style" links (#956); the composer seeds its brief + selects the style.
// `prefill=style` narrows that to style-only — select the style but leave the
// prompt blank (the styles page "Use this style" CTA). Optional, no default —
// a bare /sequences/new must stay a bare URL (no 307 rewrite).
// `from` carries a source sequence id — the "Generate Copy" entry point (#1037).
// Rather than reproduce the composer in a dialog, that action just lands here
// with everything pre-populated: the source's composed script, style, aspect
// ratio and models, and `sourceSequenceId` set so elements carry over. An id in
// the URL (not the script itself) keeps the link short, shareable and
// reload-safe — a 50k-character script could never live in a query param.
const searchSchema = z.object({
  style: z.string().optional(),
  prefill: z.enum(['style']).optional(),
  from: z.string().optional(),
});

export const Route = createFileRoute('/_app/sequences/new')({
  validateSearch: searchSchema,
  component: NewSequencePage,
  staticData: {
    breadcrumb: [
      { label: 'Sequences', to: '/sequences' },
      { label: 'New sequence' },
    ],
  },
});

function NewSequencePage() {
  const navigate = useNavigate();
  const { style: styleParam, prefill, from } = Route.useSearch();
  // Copy mode (#1037): hand the composer the source sequence and it seeds its
  // script + every generation setting from it, and creates with
  // `sourceSequenceId`. `allowScriptEdit` re-enables the editor, which is
  // read-only when the composer shows an analysed sequence's derived script —
  // correct there (the canonical text lives in scene versions), wrong here
  // (this text is only the seed for a new analysis, nothing writes back).
  const { data: sourceSequence } = useSequence(from ?? '');
  // Session is prefetched in _app/route.tsx beforeLoad, so this is settled on
  // first render — no flash for signed-in users.
  const { data: user } = useUser();

  // Sample-style prefill (#956): the showcase/gallery "Try this style" links
  // carry `?style=<slug>` (the slug the style's assets live under) + `#compose`
  // (so the router scrolls to the composer). Derive the seed straight from the
  // param during render — no effect, no state to keep in sync. The brief is
  // resolved from the style here so the URL only needs the slug; settings
  // (models, aspect ratio) follow once the style is selected. Remounting the
  // composer (`key`) on a new seed lets the `initialScript`/`initialStyleId`
  // props re-seed it — and take precedence over a stale draft (see ScriptView).
  const { data: styles } = useStyles();

  // The composer mirrors its style pick into `?style=` (see `handleStyleChange`
  // below). When that self-sync is what changed the URL, the composer must NOT
  // re-seed or remount — only a genuine external navigation (a fresh "Try" /
  // "Use this style" link, or the showcase) should. `lastSelfSyncRef` remembers
  // the slug we wrote; `seedRef` freezes the one-time seed across our own syncs
  // so picking a style never clears the script.
  const lastSelfSyncRef = useRef<string | null>(null);
  const seedRef = useRef<{ key: string; script?: string; styleId?: string }>({
    key: 'blank',
  });

  const seedStyle = styleParam
    ? styles?.find((s) => styleSlug(s.name) === styleParam)
    : undefined;
  // `prefill=style` ("Use this style", and the composer's own selection sync)
  // seeds ONLY the style; the default ("Try" / gallery) also seeds the style's
  // sample brief as the prompt.
  const styleOnly = prefill === 'style';
  let candidateScript: string | undefined;
  if (seedStyle && !styleOnly) {
    try {
      candidateScript = briefForStyle({
        name: seedStyle.name,
        category: seedStyle.category,
      });
    } catch {
      // Unmapped style — leave the composer blank rather than seed nothing.
      candidateScript = undefined;
    }
  }
  // Distinguish the two seed modes so switching between "Try" and "Use this
  // style" for the same style still re-seeds.
  const candidateKey = seedStyle
    ? `seed:${seedStyle.id}:${styleOnly ? 'style' : 'full'}`
    : 'blank';

  // Adopt the URL's seed unless this `?style=` is the composer echoing its own
  // pick back — then keep the frozen seed so the composer stays mounted and the
  // script is preserved.
  const isSelfSync =
    styleParam != null && styleParam === lastSelfSyncRef.current;
  if (!isSelfSync && candidateKey !== seedRef.current.key) {
    seedRef.current = {
      key: candidateKey,
      script: candidateScript,
      styleId: seedStyle?.id,
    };
  }
  const {
    key: composerKey,
    script: seedScript,
    styleId: seedStyleId,
  } = seedRef.current;

  // Reflect the composer's style pick in the URL so `?style=` always matches the
  // current selection (shareable, restores on reload). `replace` keeps it out of
  // the history stack.
  const handleStyleChange = useCallback(
    (styleId: string) => {
      const selected = styles?.find((s) => s.id === styleId);
      if (!selected) return;
      const slug = styleSlug(selected.name);
      lastSelfSyncRef.current = slug;
      void navigate({
        to: '/sequences/new',
        search: (prev) => ({ ...prev, style: slug, prefill: 'style' }),
        replace: true,
      });
    },
    [styles, navigate]
  );

  const { needsBillingSetup, hasFalKey, hasOpenRouterKey, stripeEnabled } =
    useBillingGate();
  const [billingOpen, setBillingOpen] = useState(false);

  // Clear billing return flag when user is back on this page
  useEffect(() => {
    localStorage.removeItem('openstory:billing-return');
  }, []);

  useEffect(() => {
    if (needsBillingSetup && !wasBillingPromptDismissed()) {
      setBillingOpen(true);
    }
  }, [needsBillingSetup]);

  const handleSuccess = useCallback(
    (sequenceIds: string[]) => {
      const [firstId] = sequenceIds;
      if (firstId) {
        // No explicit view: ScenesView forces the script view while the split
        // streams, then auto-reveals the canvas at the first preview (#1091).
        void navigate({
          to: '/sequences/$id/scenes',
          params: { id: firstId },
        });
      }
    },
    [navigate]
  );

  // Copy mode's Cancel goes back to the sequence you copied from, not to a
  // blank composer — you came from somewhere specific.
  const handleCancelCopy = useCallback(() => {
    if (!from) return;
    void navigate({ to: '/sequences/$id/scenes', params: { id: from } });
  }, [from, navigate]);

  const billingGate = (
    <BillingGateDialog
      open={billingOpen}
      onOpenChange={(open) => {
        setBillingOpen(open);
        if (!open) dismissBillingPrompt();
      }}
      hasFalKey={hasFalKey}
      hasOpenRouterKey={hasOpenRouterKey}
      stripeEnabled={stripeEnabled}
      context="onboarding"
    />
  );

  // Copy mode MUST wait for the source sequence before mounting the composer:
  // ScriptView seeds script, style, aspect ratio and models in `useState`
  // initialisers, and nothing re-syncs them afterwards. Mounted early it would
  // latch onto the defaults — blank script, first style in the list — and still
  // offer "Generate Copy", producing a copy of nothing. Navigating from the
  // sequence hides this (its detail query is already cached); a direct link or
  // a reload does not.
  if (from && !sourceSequence) {
    return (
      <div className="h-full">
        {billingGate}
        <PageContainer maxWidth="narrow" fullHeight>
          <Skeleton className="h-96 w-full" />
        </PageContainer>
      </div>
    );
  }

  // Signed-in: the script box fills the screen. Logged-out: lead with the logo
  // and tagline, then show a scrollable showcase of canonical style samples
  // below the script box (#956).
  if (user) {
    return (
      <div className="h-full">
        {billingGate}
        <PageContainer maxWidth="narrow" fullHeight>
          <ScriptView
            key={from ? `copy:${from}` : composerKey}
            loading={false}
            onSuccess={handleSuccess}
            sequence={sourceSequence}
            allowScriptEdit={!!from}
            onCancel={handleCancelCopy}
            initialScript={from ? undefined : seedScript}
            initialStyleId={from ? undefined : seedStyleId}
            onStyleChange={from ? undefined : handleStyleChange}
          />
        </PageContainer>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      {billingGate}
      <PageContainer maxWidth="narrow" padding="spacious">
        <div className="flex flex-col items-center gap-4">
          <OpenStoryLogo size="xl" />
          <h1 className="text-center text-2xl font-semibold tracking-tight">
            Tell your whole story
          </h1>
        </div>
        {/* `#compose` target: the "Try" links navigate here so the router
            scrolls the composer into view (scrollRestoration handles it). The
            card grows with its content but is capped (`max-h-[70dvh]` overrides
            the default `max-h-full`, which can't bound here — no definite-height
            ancestor like the signed-in `fullHeight` layout) so a large paste
            scrolls inside the editor instead of growing the page (#1000). */}
        <div id="compose" className="scroll-mt-4">
          <ScriptView
            key={composerKey}
            className="max-h-[70dvh]"
            loading={false}
            onSuccess={handleSuccess}
            initialScript={seedScript}
            initialStyleId={seedStyleId}
            onStyleChange={handleStyleChange}
          />
        </div>
        <SampleVideoShowcase />
      </PageContainer>
    </div>
  );
}
