import { createFileRoute, Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  formatProcessingFeePercent,
  PROCESSING_FEE_PERCENT,
} from '@/lib/billing/constants';
import { getPricingCatalogFn } from '@/functions/pricing';
import { SITE_CONFIG } from '@/lib/marketing/constants';
import { ArrowRight, KeyRound, Wallet, Zap } from 'lucide-react';

const title = `Pricing — ${SITE_CONFIG.name}`;
const description =
  'Transparent, provider-cost AI pricing. Pay what models charge — a small processing fee applies only when you buy credits.';

export const Route = createFileRoute('/_marketing/pricing')({
  component: PricingPage,
  loader: () => getPricingCatalogFn(),
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
  const feePercent = formatProcessingFeePercent();

  return (
    <main className="mx-auto max-w-5xl px-6 pb-24 pt-28">
      <header className="max-w-3xl">
        <p className="text-sm font-medium uppercase tracking-widest text-primary">
          Pricing
        </p>
        <h1 className="font-heading mt-3 text-4xl font-bold tracking-tight md:text-5xl">
          Pay provider cost. Nothing hidden.
        </h1>
        <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
          {description} Bring your own API keys to pay providers directly with
          zero platform fees.
        </p>
      </header>

      <div className="mt-10 grid gap-4 sm:grid-cols-3">
        <Card className="border-primary/20 bg-primary/5">
          <CardHeader className="gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
              <Zap className="h-5 w-5 text-primary" />
            </div>
            <CardTitle className="text-lg">At-cost usage</CardTitle>
            <CardDescription>
              Every generation is billed at the exact rate the AI provider
              charges — the same pricing you see on OpenRouter and fal.ai.
            </CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader className="gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
              <Wallet className="h-5 w-5 text-foreground" />
            </div>
            <CardTitle className="text-lg">
              {feePercent} processing fee
            </CardTitle>
            <CardDescription>
              A {feePercent} fee applies when you buy credits via Stripe — not
              on each generation. $
              {(100 * (1 + PROCESSING_FEE_PERCENT)).toFixed(0)} charged → $100
              in your wallet.
            </CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader className="gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
              <KeyRound className="h-5 w-5 text-foreground" />
            </div>
            <CardTitle className="text-lg">Bring your own keys</CardTitle>
            <CardDescription>
              Use your own fal.ai and OpenRouter keys to skip credits entirely.
              You pay the provider directly with no OpenStory fees.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>

      <div className="mt-16 flex flex-col gap-12">
        {sections.map((section) => (
          <section key={section.id} id={section.id}>
            <div className="mb-4 max-w-2xl">
              <h2 className="text-2xl font-semibold tracking-tight">
                {section.title}
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {section.description}
              </p>
            </div>

            <div className="overflow-hidden rounded-xl border">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="px-4 py-3 font-medium">Model</th>
                    <th className="hidden px-4 py-3 font-medium sm:table-cell">
                      Provider
                    </th>
                    <th className="px-4 py-3 font-medium text-right">Price</th>
                  </tr>
                </thead>
                <tbody>
                  {section.rows.map((row) => (
                    <tr
                      key={row.name}
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
                        <p className="mt-1 text-xs text-muted-foreground sm:hidden">
                          {row.provider}
                        </p>
                      </td>
                      <td className="hidden px-4 py-3 text-muted-foreground sm:table-cell">
                        {row.provider}
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
        Prices synced from provider APIs. {lastUpdated}. Actual charges reflect
        reported usage (tokens, seconds, images) and may vary slightly from
        estimates.
      </p>

      <div className="mt-12 flex flex-col items-center gap-4 rounded-2xl border bg-muted/30 px-6 py-10 text-center">
        <h2 className="text-xl font-semibold">Ready to start creating?</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          Add credits from your dashboard, or connect API keys in Settings. No
          subscriptions — pay only for what you use.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button asChild size="lg">
            <Link to="/sequences/new">
              Get started
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
          <Button asChild variant="outline" size="lg">
            <Link to="/credits">Add credits</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
