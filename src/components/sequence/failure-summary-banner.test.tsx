import { CONTENT_REJECTION_USER_HINT } from '@/lib/ai/content-rejection';
import type { FailureSummary } from '@/lib/failures/failure-analysis';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FailureSummaryBanner } from './failure-summary-banner';

const contentSummary: FailureSummary = {
  requiresFullRetry: true,
  headline:
    "Harry Potter didn't pass the content checker \u2014 regenerate to retry",
  groups: [],
  totalFailures: 1,
  hasFailed: true,
  error: 'Blocked by the content checker: Harry Potter',
  tone: 'warning',
};

describe('FailureSummaryBanner', () => {
  it('SSRs the content-checker title instead of Generation failed', () => {
    const html = renderToStaticMarkup(
      <FailureSummaryBanner
        summary={contentSummary}
        onRetry={() => undefined}
        isRetrying={false}
      />
    );

    expect(html).toContain('Content checker');
    expect(html).toContain('pass the content checker');
    expect(html).toContain('regenerate to retry');
    expect(html).toContain(CONTENT_REJECTION_USER_HINT);
    expect(html).not.toContain('Generation failed');
  });
});
