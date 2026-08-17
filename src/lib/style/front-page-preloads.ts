/**
 * First-paint image preloads for the anonymous composer (`/`).
 *
 * Showcase posters are the LCP candidates (large 16:9 cards). Style tiles
 * are ~65px and ride along once the styles query is dehydrated into HTML.
 */
import { videoPosterUrl } from '@/lib/media/cloudflare-video';
import { buildSampleEntries } from '@/lib/style/sample-entries';
import type { Style } from '@/types/database';

export const FRONT_PAGE_SHOWCASE_PRELOAD_COUNT = 3;

export type FrontPagePreloadLink = {
  rel: 'preload';
  as: 'image';
  href: string;
  fetchPriority?: 'high';
};

export function frontPageImagePreloadLinks(
  styles: Style[] | undefined
): FrontPagePreloadLink[] {
  if (!styles?.length) return [];

  const links: FrontPagePreloadLink[] = [];
  const entries = buildSampleEntries(styles).slice(
    0,
    FRONT_PAGE_SHOWCASE_PRELOAD_COUNT
  );

  for (const [index, entry] of entries.entries()) {
    const poster = videoPosterUrl(entry.video.url);
    if (!poster) continue;
    links.push({
      rel: 'preload',
      as: 'image',
      href: poster,
      ...(index === 0 ? { fetchPriority: 'high' as const } : {}),
    });
  }

  return links;
}
