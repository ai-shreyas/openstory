/**
 * Public model pricing catalog — lives in the app shell so it matches the
 * rest of the product chrome (sidebar, breadcrumbs). Anonymous-browsable.
 */

import { createFileRoute, Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  formatPlatformFeePercent,
  PLATFORM_FEE_PERCENT,
} from '@/lib/billing/constants';
import { getPricingCatalogFn } from '@/functions/pricing';
import { openAddCreditsDialog } from '@/hooks/use-add-credits-dialog';
import { SITE_CONFIG } from '@/lib/marketing/constants';
import { ArrowRight, ArrowUpRight, KeyRound } from 'lucide-react';

const title = `Pricing — ${SITE_CONFIG.name}`;
const description =
  'Pay-as-you-go credits for AI generations — no subscription. Bring your own keys to pay platforms directly.';

export const Route = createFileRoute('/_app/pricing')({
  component: PricingPage,
  loader: () => getPricingCatalogFn(),
  staticData: { breadcrumb: 'Pricing' },
  head: () => ({
    meta: [
      { title },
      { name: 'description', content: description },
      { property: 'og:title', content: title },
      { property: 'og:description', content: description },
      { property: 'og:url', content: `${SITE_CONFIG.url}/pricing` },
      { name: 'twitter:title', content: title },
      { name: 'twitter:description', content: description },
    ],
  }),
});

function PricingPage() {
  const { sections, lastUpdated } = Route.useLoaderData();
  const feePercent = formatPlatformFeePercent();
  const chargeFor100 = (100 * (1 + PLATFORM_FEE_PERCENT)).toFixed(0);

  return (
    <div className="mx-auto w-full max-w-5xl p-6 pb-16">
      <header className="max-w-2xl">
        <h1 className="font-heading text-3xl font-bold tracking-tight">
          Credits for generations
        </h1>
        <p className="mt-3 text-base leading-relaxed text-muted-foreground">
          Pay as you go — no subscription. Each run draws credits at the
          provider&rsquo;s rate via the platform that hosts it (today: fal.ai
          and OpenRouter). Many models price by resolution, duration, or tokens.
          Open a Via link for the full tariff on that platform.
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          A {feePercent} platform fee applies when you buy credits ($
          {chargeFor100} charged → $100 wallet) — not on each generation. Or
          connect your own keys in Settings to pay platforms directly with no
          OpenStory fee.
        </p>
      </header>

      <div className="mt-6 flex items-start gap-3 rounded-xl border px-4 py-3 text-sm text-muted-foreground">
        <KeyRound className="mt-0.5 size-4 shrink-0" />
        <p>
          <span className="font-medium text-foreground">
            Bring your own keys
          </span>
          {' — '}
          fal.ai covers media; OpenRouter is optional for script analysis. You
          pay the platform directly and skip the credit wallet.
        </p>
      </div>

      <div className="mt-12 flex flex-col gap-12">
        {sections.map((section) => (
          <section key={section.id} id={section.id}>
            <div className="mb-4 max-w-2xl">
              <h2 className="text-xl font-semibold tracking-tight">
                {section.title}
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {section.description}
              </p>
            </div>

            <div className="overflow-x-auto rounded-xl border">
              <table className="w-full min-w-[36rem] text-left text-sm">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="px-4 py-3 font-medium">Model</th>
                    <th className="px-4 py-3 font-medium">Lab</th>
                    <th className="px-4 py-3 font-medium">Via</th>
                    <th className="px-4 py-3 font-medium text-right">
                      Indicative rate
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {section.rows.map((row) => (
                    <tr
                      key={`${row.via}-${row.name}`}
                      className="border-b last:border-b-0 hover:bg-muted/20"
                    >
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{row.name}</span>
                          {row.license === 'open-source' && (
                            <Badge variant="secondary" className="text-xs">
                              Open source
                            </Badge>
                          )}
                        </div>
                        {row.detail && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {row.detail}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {row.lab}
                      </td>
                      <td className="px-4 py-3">
                        <a
                          href={row.docsUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                        >
                          {row.via}
                          <ArrowUpRight className="size-3.5 shrink-0" />
                        </a>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs tabular-nums sm:text-sm">
                        {row.price}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </div>

      <p className="mt-10 text-center text-xs text-muted-foreground">
        Indicative rates from platform APIs ({lastUpdated}). Actual charges
        follow billed units (tokens, seconds, images, resolution tiers). Use
        each row&rsquo;s Via link for that platform&rsquo;s full pricing.
      </p>

      <div className="mt-12 flex flex-col items-center gap-4 rounded-2xl border bg-muted/30 px-6 py-10 text-center">
        <h2 className="text-xl font-semibold">Ready to start creating?</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          Add credits from your dashboard, or connect API keys in Settings. No
          subscriptions — pay only for what you use.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button asChild size="lg">
            <Link to="/">
              Get started
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
          <Button variant="outline" size="lg" onClick={openAddCreditsDialog}>
            Add credits
          </Button>
        </div>
      </div>
    </div>
  );
}
