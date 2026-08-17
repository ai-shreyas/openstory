import { generateMockStyles } from '@/lib/mocks/data-generators';
import { videoPosterUrl } from '@/lib/media/cloudflare-video';
import {
  FRONT_PAGE_SHOWCASE_PRELOAD_COUNT,
  frontPageImagePreloadLinks,
} from '@/lib/style/front-page-preloads';
import type { Style } from '@/types/database';
import { describe, expect, it } from 'vitest';

function makeStyle(over: Partial<Style>): Style {
  const [base] = generateMockStyles(1);
  if (!base) throw new Error('expected a mock style');
  return { ...base, ...over };
}

describe('frontPageImagePreloadLinks', () => {
  it('returns nothing without styles', () => {
    expect(frontPageImagePreloadLinks(undefined)).toEqual([]);
    expect(frontPageImagePreloadLinks([])).toEqual([]);
  });

  it('preloads the first showcase posters and marks the first as high priority', () => {
    const styles = Array.from({ length: 5 }, (_, i) =>
      makeStyle({
        id: `s${i}`,
        name: `Style ${i}`,
        sampleVideos: [
          {
            url: `https://assets.openstory.so/styles/s${i}/canonical.mp4`,
            kind: 'canonical',
            label: 'Sample',
            durationSeconds: 15,
            order: 0,
          },
        ],
      })
    );

    const links = frontPageImagePreloadLinks(styles);
    expect(links).toHaveLength(FRONT_PAGE_SHOWCASE_PRELOAD_COUNT);
    expect(links[0]).toMatchObject({
      rel: 'preload',
      as: 'image',
      fetchPriority: 'high',
    });
    expect(links[0]?.href).toBe(
      videoPosterUrl('https://assets.openstory.so/styles/s0/canonical.mp4')
    );
    expect(links[1]?.fetchPriority).toBeUndefined();
  });
});
