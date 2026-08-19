/**
 * Theatre View
 *
 * Plays a sequence live in the browser — stitches scene videos + music via
 * Mediabunny without producing a server-side merged-MP4 artifact. Exporting
 * an MP4 is an explicit user action (the Share menu's "Export as MP4"); the
 * blob lands in `sequence_exports`.
 */

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { SequencePlayer } from '@/components/theatre/sequence-player';
import { useSequenceExport } from '@/components/theatre/use-sequence-export';
import { useShotsBySequence } from '@/hooks/use-shots';
import { useSetSequenceMusic } from '@/hooks/use-sequences';
import type { ExportProgress } from '@/lib/sequence-player/export';
import type { Sequence } from '@/types/database';
import { copyTextToClipboard } from '@/lib/utils/clipboard';
import { Download, Film, Link, Loader2, Share2 } from 'lucide-react';
import { usePostHog } from '@posthog/react';
import { useCallback, useMemo } from 'react';
import { toast } from 'sonner';

type TheatreViewProps = {
  sequence: Sequence;
};

export const TheatreView: React.FC<TheatreViewProps> = ({ sequence }) => {
  const posthog = usePostHog();
  const { data: shots } = useShotsBySequence(sequence.id);
  const sequenceExport = useSequenceExport(sequence);
  const setMusicEnabled = useSetSequenceMusic(sequence.id);

  const scenes = useMemo(() => {
    if (!shots) return [];
    return shots
      .map((f) => f.video?.url)
      .filter((url): url is string => Boolean(url))
      .map((videoUrl, orderIndex) => ({ orderIndex, videoUrl }));
  }, [shots]);

  const shareUrl = sequenceExport.latestExportUrl;

  const handleCopyShareUrl = useCallback(async () => {
    if (!shareUrl) {
      toast.error('Export an MP4 first to get a shareable URL.');
      return;
    }
    try {
      // Stored export URLs are origin-relative (#894) — absolutize against the
      // current origin so the copied link is usable when pasted elsewhere. The
      // worker's public /r2 route serves it (redirecting to the CDN in prod).
      const absoluteUrl = new URL(shareUrl, window.location.origin).href;
      if (!(await copyTextToClipboard(absoluteUrl))) {
        toast.error('Failed to copy URL');
        posthog.captureException(new Error('Clipboard write blocked'));
        return;
      }
      toast.success('Video URL copied');
      posthog.capture('video_url_copied', { sequence_id: sequence.id });
    } catch (err) {
      toast.error('Failed to copy URL');
      posthog.captureException(err);
    }
  }, [shareUrl, sequence.id, posthog]);

  const handleDownloadLatest = useCallback(() => {
    if (!shareUrl) {
      sequenceExport.start();
      return;
    }
    const a = document.createElement('a');
    a.href = shareUrl;
    a.download = `${sequence.title || 'sequence'}_openstory.mp4`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    posthog.capture('video_downloaded', { sequence_id: sequence.id });
  }, [shareUrl, sequence.id, sequence.title, posthog, sequenceExport]);

  if (!shots) {
    return <Skeleton className="aspect-video w-full" />;
  }

  const allScenesReady = scenes.length === shots.length;
  if (!allScenesReady || scenes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-16">
        <Film className="h-8 w-8 text-muted-foreground" />
        <p className="text-muted-foreground">No scenes ready yet</p>
        <p className="text-sm text-muted-foreground max-w-md text-center">
          The theatre will play live once every scene video is generated.
        </p>
      </div>
    );
  }

  const overlay = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 bg-black/50 text-white hover:bg-black/70"
          aria-label="Share"
        >
          <Share2 className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => void handleCopyShareUrl()}>
          <Link className="h-4 w-4" />
          Copy latest export URL
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={sequenceExport.start}
          disabled={sequenceExport.isRunning}
        >
          {sequenceExport.isRunning ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          {sequenceExport.isRunning
            ? formatExportProgress(sequenceExport.progress)
            : 'Export as MP4'}
        </DropdownMenuItem>
        {shareUrl && (
          <DropdownMenuItem onClick={handleDownloadLatest}>
            <Download className="h-4 w-4" />
            Download last export
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <SequencePlayer
      scenes={scenes}
      musicUrl={sequence.musicUrl ?? null}
      musicLoudnessGainDb={null}
      musicEnabled={sequence.includeMusic}
      onMusicEnabledChange={(enabled) => setMusicEnabled.mutate(enabled)}
      aspectRatio={sequence.aspectRatio}
      overlayActions={overlay}
    />
  );
};

function formatExportProgress(progress: ExportProgress | null): string {
  if (!progress) return 'Exporting…';
  const phaseLabel: Record<ExportProgress['phase'], string> = {
    prepare: 'Preparing',
    video: 'Stitching video',
    music: 'Downloading music',
    dialogue: 'Decoding dialogue',
    mix: 'Mixing audio',
    encode: 'Encoding audio',
    finalize: 'Finalizing',
    upload: 'Uploading',
    commit: 'Saving',
  };
  const label = phaseLabel[progress.phase];
  if (progress.total > 0) {
    const pct = Math.min(
      100,
      Math.round((progress.completed / progress.total) * 100)
    );
    return `${label}… ${pct}%`;
  }
  return `${label}…`;
}
