import { AppLayout } from '@/components/layout/app-layout';
import { SiteHeader } from '@/components/marketing/site-header';
import { SiteFooter } from '@/components/marketing/site-footer';
import {
  createFileRoute,
  Outlet,
  useRouterState,
} from '@tanstack/react-router';

export const Route = createFileRoute('/_marketing')({
  component: MarketingLayout,
});

function MarketingLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Home is the product composer in the app shell (#1104) — not a marketing
  // landing page. Privacy/terms keep the marketing header/footer chrome.
  if (pathname === '/') {
    return (
      <AppLayout>
        <Outlet />
      </AppLayout>
    );
  }

  return (
    <>
      <SiteHeader />
      <Outlet />
      <SiteFooter />
    </>
  );
}
