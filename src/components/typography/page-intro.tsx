import { PageContainer } from '@/components/layout/page-container';
import { PageDescription } from '@/components/typography/page-description';
import { PageHeader } from '@/components/typography/page-header';
import type { ReactNode } from 'react';

/**
 * Locked chrome for the page one-liner. Same inset, size, and left alignment
 * on every list page (and the signed-in composer). Sit this *outside* any
 * max-width content container so the line does not shift when the grid does.
 */
export function PageIntro({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <PageContainer maxWidth="full" padding="compact" className="shrink-0">
      <h1 className="sr-only">{title}</h1>
      <PageHeader actions={actions} className="items-start">
        <PageDescription>{children}</PageDescription>
      </PageHeader>
    </PageContainer>
  );
}
