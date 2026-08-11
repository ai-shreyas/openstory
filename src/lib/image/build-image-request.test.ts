import { EDIT_ENDPOINTS } from '@/lib/ai/models';
import { typedEntries } from '@/lib/utils/typed-object';
import { describe, expect, it } from 'vitest';
import { buildImageRequest } from './build-image-request';

const REFS = ['https://example.com/a.png', 'https://example.com/b.png'];

const editModels = typedEntries(EDIT_ENDPOINTS).map(([model]) => model);

describe('buildImageRequest — edit endpoints carry their reference images', () => {
  /**
   * Routing and payload are decided in two different places: the endpoint is
   * picked from EDIT_ENDPOINTS whenever references exist, but `image_urls` is
   * spread per-model in the switch. flux_2_turbo was the one case that routed
   * to `/edit` while omitting them, so fal rejected every reference render with
   * a 422 "Field required". Assert the pair stays consistent for every model
   * rather than for one — the next model added is the next place to forget.
   */
  it.each(editModels)(
    '%s sends image_urls when it routes to its edit endpoint',
    (model) => {
      const { endpointId, input } = buildImageRequest({
        model,
        prompt: 'a lighthouse at dusk',
        referenceImageUrls: REFS,
      });

      expect(endpointId).toBe(EDIT_ENDPOINTS[model]);
      expect(input).toMatchObject({ image_urls: REFS });
    }
  );

  it.each(editModels)(
    '%s omits image_urls and stays on text-to-image without references',
    (model) => {
      const { endpointId, input } = buildImageRequest({
        model,
        prompt: 'a lighthouse at dusk',
      });

      expect(endpointId).not.toBe(EDIT_ENDPOINTS[model]);
      expect(input).not.toHaveProperty('image_urls');
    }
  );
});
