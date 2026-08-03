import { cn } from '@/lib/utils';
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import type * as React from 'react';
import { AuthGateProvider } from '@/components/auth/auth-gate-provider';
import { AddCreditsDialog } from '@/components/billing/add-credits-dialog';
import { WelcomeCreditsDialog } from '@/components/billing/welcome-credits-dialog';
import { AppSidebar } from './app-sidebar';
import { Breadcrumbs } from './breadcrumbs';
import { InvalidApiKeyBanner } from './invalid-api-key-banner';

interface AppLayoutProps extends React.HTMLAttributes<HTMLElement> {}

export const AppLayout: React.FC<AppLayoutProps> = ({
  className,
  children,
  ...props
}) => {
  return (
    <AuthGateProvider>
      <SidebarProvider className="h-svh">
        <AppSidebar />
        <WelcomeCreditsDialog />
        <AddCreditsDialog />
        <SidebarInset className="min-w-0 min-h-0">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
            <SidebarTrigger />
            <Separator orientation="vertical" className="mx-1 h-4" />
            <Breadcrumbs />
          </header>
          <InvalidApiKeyBanner />
          <div
            className={cn(
              'flex flex-col flex-1 min-w-0 min-h-0 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]',
              className
            )}
            {...props}
          >
            {children}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </AuthGateProvider>
  );
};
