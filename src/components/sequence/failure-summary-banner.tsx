import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  CONTENT_REJECTION_USER_HINT,
  userFacingGenerationError,
} from '@/lib/ai/content-rejection';
import type { FailureSummary } from '@/lib/failures/failure-analysis';
import { AlertCircle, Info, RotateCcw } from 'lucide-react';

type FailureSummaryBannerProps = {
  summary: FailureSummary;
  onRetry: () => void;
  onFullRetry?: () => void;
  isRetrying: boolean;
};

export const FailureSummaryBanner: React.FC<FailureSummaryBannerProps> = ({
  summary,
  onRetry,
  onFullRetry,
  isRetrying,
}) => {
  const isWarning = summary.tone === 'warning';
  return (
    <Alert
      variant={isWarning ? 'default' : 'destructive'}
      className="mx-4 mt-2"
    >
      {isWarning ? (
        <Info className="h-4 w-4" />
      ) : (
        <AlertCircle className="h-4 w-4" />
      )}
      <AlertTitle>
        {summary.requiresFullRetry
          ? 'Generation failed'
          : isWarning
            ? 'Content checker'
            : 'Generation partially failed'}
      </AlertTitle>
      <AlertDescription>
        <p>{summary.headline}</p>
        {isWarning && <p>{CONTENT_REJECTION_USER_HINT}</p>}

        {summary.groups.length === 0 && summary.error && !isWarning && (
          <p className="mt-1 text-xs font-mono">
            {userFacingGenerationError(summary.error).title}
          </p>
        )}

        {summary.groups.length > 0 && (
          <details className="mt-2">
            <summary className="cursor-pointer text-xs underline">
              {isWarning ? 'Which shots' : 'View error details'}
            </summary>
            <div className="mt-2 space-y-2 text-xs font-mono">
              {summary.groups.map((group) => (
                <div key={group.category}>
                  <span className="font-semibold">{group.category}:</span>
                  {group.shots.map((f) => {
                    const facing = userFacingGenerationError(f.error);
                    return (
                      <div key={f.shotId} className="ml-2">
                        Scene {f.sceneNumber}
                        {f.sceneTitle !== `Scene ${f.sceneNumber}` &&
                          ` (${f.sceneTitle})`}
                        {isWarning ? '' : `: ${facing.title}`}
                      </div>
                    );
                  })}
                  {group.error && !isWarning && (
                    <div className="ml-2">
                      {userFacingGenerationError(group.error).title}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </details>
        )}

        <Button
          variant="outline"
          size="sm"
          onClick={
            summary.requiresFullRetry && onFullRetry ? onFullRetry : onRetry
          }
          disabled={isRetrying}
          className="mt-2"
        >
          <RotateCcw
            className={`h-3 w-3 ${isRetrying ? 'animate-spin' : ''}`}
          />
          {isRetrying
            ? 'Retrying\u2026'
            : summary.requiresFullRetry
              ? 'Regenerate Sequence'
              : isWarning
                ? 'Retry'
                : 'Retry Failed'}
        </Button>
      </AlertDescription>
    </Alert>
  );
};
