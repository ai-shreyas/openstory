import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { VideoPlayer } from '@/components/motion/video-player';
import { useStyles } from '@/hooks/use-styles';
import { getAspectRatioClassName } from '@/lib/constants/aspect-ratios';
import {
  optimizedVideoUrl,
  videoPosterUrl,
} from '@/lib/media/cloudflare-video';
import {
  buildSampleEntries,
  type SampleEntry,
} from '@/lib/style/sample-entries';
import { cn } from '@/lib/utils';
import { Link } from '@tanstack/react-router';
import { ArrowRight, Wand2 } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';

/** Max styles to feature in the curated showcase so it stays a teaser, not a dump. */
const MAX_STYLES = 9;

/**
 * Logged-out showcase for the new-sequence screen (#956): a curated grid of
 * canonical style sample videos so anonymous visitors can see the sort of thing
 * they can create, each labelled with the style that produced it. Each card's
 * "Try this style" button links to `/sequences/new?style=<id>`; the composer
 * seeds itself from that param (see new.tsx), so the transport is URL-driven
 * and shareable.
 */
export const SampleVideoShowcase: React.FC = () => {
  const { data: styles, isPending } = useStyles();

  if (isPending) {
    return (
      <section className="flex flex-col gap-4">
        <ShowcaseHeading />
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="aspect-video w-full rounded-lg" />
          ))}
        </div>
      </section>
    );
  }

  const entries = buildSampleEntries(styles ?? []).slice(0, MAX_STYLES);
  if (entries.length === 0) return null;

  return (
    <section className="flex flex-col gap-4">
      <ShowcaseHeading />
      <Link
        to="/gallery"
        className="inline-flex items-center justify-center gap-1 self-center text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        Browse the full gallery
        <ArrowRight className="size-4" />
      </Link>
      <div className="grid grid-cols-2 items-start gap-4 md:grid-cols-3">
        {entries.map((entry) => (
          <SampleVideoCard key={entry.key} entry={entry} />
        ))}
      </div>
    </section>
  );
};

const ShowcaseHeading: React.FC = () => (
  <div className="flex flex-col gap-1 text-center">
    <h2 className="text-lg font-semibold tracking-tight">
      See what you can create
    </h2>
    <p className="text-sm text-muted-foreground">
      Every clip below was generated from a one-line idea, in a different style.
    </p>
  </div>
);

export const SampleVideoCard: React.FC<{ entry: SampleEntry }> = ({
  entry,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [open, setOpen] = useState(false);

  // Resting state is a cheap Cloudflare-extracted poster frame (~36KB jpg) and
  // `preload="none"`, so the page paints without fetching a single video byte.
  // The downscaled clip (Cloudflare `mode=video`, ~6× smaller than the master)
  // is only fetched + played on hover. Touch devices that fire no hover keep
  // showing the poster. Clicking the card opens a dialog with a full player
  // (controls + sound). The dialog uses a larger downscale so it's sharp at
  // size without paying for the full master clip.
  const poster = videoPosterUrl(entry.video.url);
  const src = optimizedVideoUrl(entry.video.url);
  const playerSrc = optimizedVideoUrl(entry.video.url, 1280);

  const play = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    void el.play().catch(() => {});
  }, []);

  const stop = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    el.pause();
    el.currentTime = 0;
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <div
        className={cn(
          'group relative w-full overflow-hidden rounded-lg border bg-muted',
          getAspectRatioClassName(entry.aspectRatio)
        )}
        onMouseEnter={play}
        onMouseLeave={stop}
      >
        <video
          ref={videoRef}
          src={src}
          poster={poster}
          className="absolute inset-0 h-full w-full object-cover"
          muted
          loop
          playsInline
          preload="none"
          aria-hidden="true"
        />
        {/* Full-card click target that opens the player dialog. Layered over the
            preview video; the style label and Try button render after it so they
            stay on top and keep their own behaviour. */}
        <DialogTrigger asChild>
          <button
            type="button"
            aria-label={`Play the ${entry.styleName} sample video`}
            className="absolute inset-0 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          />
        </DialogTrigger>
        <span className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-background/70 px-2 py-0.5 text-xs font-medium backdrop-blur-sm">
          {entry.styleName}
        </span>
        {entry.hasBrief && (
          <Button
            asChild
            size="sm"
            variant="secondary"
            className="absolute bottom-2 right-2 gap-1.5 opacity-90 backdrop-blur-sm transition-opacity group-hover:opacity-100"
          >
            <Link
              to="/sequences/new"
              search={{ style: entry.slug }}
              hash="compose"
              aria-label={`Try the ${entry.styleName} style`}
            >
              <Wand2 className="size-3.5" />
              Try
            </Link>
          </Button>
        )}
      </div>
      <DialogContent className="max-w-3xl gap-3 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{entry.styleName}</DialogTitle>
        </DialogHeader>
        {/* Mounted only while open so no video bytes load until the dialog is
            actually shown, and playback resets on close. VideoPlayer forces a
            full-width aspect-ratio box, so cap the width per aspect ratio — a
            tall 9:16 clip would otherwise derive a height that overflows the
            viewport. The cap keeps the derived height within ~75vh. */}
        {open && (
          <VideoPlayer
            src={playerSrc}
            posterSrc={poster}
            aspectRatio={entry.aspectRatio}
            autoPlay
            className={cn(
              'mx-auto overflow-hidden rounded-lg',
              entry.aspectRatio === '9:16' && 'max-w-[42vh]',
              entry.aspectRatio === '1:1' && 'max-w-[75vh]'
            )}
          />
        )}
        {entry.hasBrief && (
          <Button asChild className="gap-1.5">
            <Link
              to="/sequences/new"
              search={{ style: entry.slug }}
              hash="compose"
            >
              <Wand2 className="size-4" />
              Try the {entry.styleName} style
            </Link>
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
};
