import { useEffect, useState } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Menu } from 'lucide-react';
import { OpenStoryLogo } from '@/components/icons/openstory-logo';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { sessionQueryOptions } from '@/lib/auth/session-query';
import { SITE_CONFIG } from '@/lib/marketing/constants';

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
    </svg>
  );
}

const navLinks = [
  { href: '/pricing', label: 'Pricing', external: false },
  { href: '/docs', label: 'Docs', external: false },
  { href: SITE_CONFIG.githubHref, label: 'GitHub', external: true, icon: true },
] as const;

export function SiteHeader() {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const { data: session } = useQuery(sessionQueryOptions);
  const isLoggedIn = !!session?.user;
  const routerState = useRouterState();
  const isLandingPage = routerState.location.pathname === '/';

  useEffect(() => {
    if (!isLandingPage) {
      setScrolled(true);
      return;
    }

    const handleScroll = () => {
      setScrolled(window.scrollY > 80);
    };

    handleScroll();
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [isLandingPage]);

  const ctaLabel = isLoggedIn ? 'Dashboard' : 'Login';
  const ctaHref = isLoggedIn ? '/sequences' : '/login';
  const isTransparent = isLandingPage && !scrolled;

  return (
    <header
      className={`fixed top-0 z-50 w-full transition-all duration-300 ${
        isTransparent
          ? 'bg-transparent'
          : 'border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60'
      }`}
    >
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
        <Link to="/" aria-label="OpenStory home">
          <OpenStoryLogo
            size="md"
            className={isTransparent ? 'text-white' : ''}
          />
        </Link>

        <nav className="hidden items-center gap-8 md:flex">
          {navLinks.map((link) => {
            const cls = `text-sm font-medium tracking-wide transition-colors ${
              isTransparent
                ? 'text-white/70 hover:text-white'
                : 'text-muted-foreground hover:text-foreground'
            }`;

            if (link.external) {
              return (
                <a
                  key={link.label}
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`inline-flex items-center gap-1.5 ${cls}`}
                >
                  {'icon' in link && <GitHubIcon className="size-4" />}
                  {link.label}
                </a>
              );
            }

            return (
              <Link key={link.label} to={link.href} className={cls}>
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="hidden md:block">
          <Button
            asChild
            className={
              isTransparent
                ? 'bg-white/15 text-white backdrop-blur-sm hover:bg-white/25'
                : ''
            }
          >
            <Link to={ctaHref}>{ctaLabel}</Link>
          </Button>
        </div>

        <Button
          variant="ghost"
          size="icon"
          className={`md:hidden ${isTransparent ? 'text-white hover:bg-white/10' : ''}`}
          onClick={() => setSheetOpen(true)}
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" />
        </Button>
      </div>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="left">
          <SheetHeader>
            <SheetTitle>Navigation</SheetTitle>
          </SheetHeader>
          <nav className="flex flex-col gap-2 px-4">
            {navLinks.map((link) => {
              const mobileCls =
                'rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground';

              if (link.external) {
                return (
                  <a
                    key={link.label}
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`inline-flex items-center gap-1.5 ${mobileCls}`}
                    onClick={() => setSheetOpen(false)}
                  >
                    {'icon' in link && <GitHubIcon className="size-4" />}
                    {link.label}
                  </a>
                );
              }

              return (
                <Link
                  key={link.label}
                  to={link.href}
                  className={mobileCls}
                  onClick={() => setSheetOpen(false)}
                >
                  {link.label}
                </Link>
              );
            })}
            <Button asChild className="mt-2">
              <Link to={ctaHref} onClick={() => setSheetOpen(false)}>
                {ctaLabel}
              </Link>
            </Button>
          </nav>
        </SheetContent>
      </Sheet>
    </header>
  );
}
