import { Skeleton } from '@/components/ui/skeleton';
import {
  getAspectRatioClassName,
  type AspectRatio,
} from '@/lib/constants/aspect-ratios';
import { cn } from '@/lib/utils';
import type { Media, Video as VideoMedia } from '@videojs/core';
import { createPlayer, Poster, useMedia } from '@videojs/react';
import { MinimalVideoSkin, Video, videoFeatures } from '@videojs/react/video';
import { useEffect, useRef } from 'react';

// useMedia() returns the base Media capability set; the <Video> component
// renders an instance with the full Video capability set (seek/source/etc.).
const isVideoMedia = (media: Media): media is VideoMedia =>
  'duration' in media && 'currentTime' in media;

// `createPlayer` constructs an AbortController, which the Cloudflare Workers
// runtime only permits inside a request (i.e. during render), NOT at module /
// global scope. Creating it at module scope crashes SSR ("Disallowed operation
// … within global scope"). So build it lazily on first render and memoise it as
// a singleton — the same request-scoped lazy-init pattern we use for the Drizzle
// client and other Workers-sensitive resources. Video.js itself renders fine on
// the server (markup now, interactivity after hydration); only this eager
// construction was the problem.
let playerSingleton: ReturnType<typeof createPlayer> | undefined;
const getPlayer = () =>
  (playerSingleton ??= createPlayer({ features: videoFeatures }));

type VideoPlayerProps = {
  src: string;
  chaptersUrl?: string;
  posterSrc?: string | null;
  aspectRatio: AspectRatio;
  className?: string;
  autoPlay?: boolean;
  onLoadedMetadata?: (duration: number) => void;
  onTimeUpdate?: (currentTime: number) => void;
  onPause?: () => void;
  onEnded?: () => void;
};

const VideoPlayerInner: React.FC<
  Omit<VideoPlayerProps, 'aspectRatio' | 'className'>
> = ({
  src,
  chaptersUrl,
  posterSrc,
  autoPlay = false,
  onLoadedMetadata,
  onTimeUpdate,
  onPause,
  onEnded,
}) => {
  const media = useMedia();
  const callbacksRef = useRef({
    onLoadedMetadata,
    onTimeUpdate,
    onPause,
    onEnded,
  });
  callbacksRef.current = { onLoadedMetadata, onTimeUpdate, onPause, onEnded };

  useEffect(() => {
    if (!media || !isVideoMedia(media)) return;
    const el = media;

    const handleLoadedMetadata = () => {
      callbacksRef.current.onLoadedMetadata?.(el.duration);
    };
    const handleTimeUpdate = () => {
      callbacksRef.current.onTimeUpdate?.(el.currentTime);
    };
    const handlePause = () => {
      callbacksRef.current.onPause?.();
    };
    const handleEnded = () => {
      callbacksRef.current.onEnded?.();
    };

    el.addEventListener('loadedmetadata', handleLoadedMetadata);
    el.addEventListener('timeupdate', handleTimeUpdate);
    el.addEventListener('pause', handlePause);
    el.addEventListener('ended', handleEnded);

    return () => {
      el.removeEventListener('loadedmetadata', handleLoadedMetadata);
      el.removeEventListener('timeupdate', handleTimeUpdate);
      el.removeEventListener('pause', handlePause);
      el.removeEventListener('ended', handleEnded);
    };
  }, [media]);

  return (
    <MinimalVideoSkin>
      <Video
        src={src || undefined}
        playsInline
        autoPlay={autoPlay}
        preload="metadata"
      >
        {chaptersUrl && <track kind="chapters" src={chaptersUrl} default />}
      </Video>
      {posterSrc && <Poster src={posterSrc} alt="Video thumbnail" />}
    </MinimalVideoSkin>
  );
};

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  src,
  chaptersUrl,
  posterSrc,
  aspectRatio,
  className,
  autoPlay = false,
  onLoadedMetadata,
  onTimeUpdate,
  onPause,
  onEnded,
}) => {
  // Show skeleton when there's no video source and no poster
  if (!src && !posterSrc) {
    return (
      <Skeleton
        className={cn(
          'w-full',
          className,
          getAspectRatioClassName(aspectRatio)
        )}
      />
    );
  }

  // Image-only mode: VideoSkin collapses to 0px without a video src, so render
  // the poster directly into a properly-sized aspect-ratio container instead.
  if (!src && posterSrc) {
    return (
      <div
        className={cn(
          'relative w-full overflow-hidden',
          className,
          getAspectRatioClassName(aspectRatio)
        )}
      >
        {/* key forces a fresh <img> when the still changes so the browser
            never keeps the previous shot's decoded bitmap after a switch. */}
        <img
          key={posterSrc}
          src={posterSrc}
          alt="Scene thumbnail"
          className="absolute inset-0 h-full w-full object-cover"
        />
      </div>
    );
  }

  const Player = getPlayer();

  return (
    <div
      className={cn(
        'relative w-full',
        className,
        getAspectRatioClassName(aspectRatio)
      )}
    >
      <Player.Provider>
        <VideoPlayerInner
          src={src}
          chaptersUrl={chaptersUrl}
          posterSrc={posterSrc}
          autoPlay={autoPlay}
          onLoadedMetadata={onLoadedMetadata}
          onTimeUpdate={onTimeUpdate}
          onPause={onPause}
          onEnded={onEnded}
        />
      </Player.Provider>
    </div>
  );
};
