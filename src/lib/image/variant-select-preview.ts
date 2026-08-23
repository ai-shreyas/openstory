import type { ShotView } from '@/lib/shots/shot-view';

/**
 * Trim URLs (`/cdn-cgi/image/trim=`) only resolve through a Cloudflare
 * Image Resizing edge. Patching one into `image.url` is what #1193's broken
 * preview was. `/r2/`, `blob:`, and ordinary https URLs are safe to show.
 */
export function isBrowserDisplayableStillUrl(url: string): boolean {
  return !url.includes('/cdn-cgi/image/');
}

/**
 * Optimistic shot after the user picks a grid tile: show the cropped still
 * (if we have one), spin the frame, and drop the old motion so the player
 * doesn't keep playing the previous video over the new start frame.
 */
export function shotAfterVariantSelect(
  shot: ShotView,
  imageUrl: string | undefined
): ShotView {
  return {
    ...shot,
    image:
      imageUrl && shot.image ? { ...shot.image, url: imageUrl } : shot.image,
    frame: { ...shot.frame, imageStatus: 'generating' },
    pendingUpscaleUrl: imageUrl ?? shot.pendingUpscaleUrl ?? null,
    video: null,
    videoStatus: 'pending',
  };
}
