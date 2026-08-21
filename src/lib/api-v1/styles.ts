/**
 * Public `/api/v1/styles` documents (#1227). Create goes straight through
 * `scopedDb.styles.create` (slug-unique per team, server-managed columns
 * stripped); this module only shapes the HAL responses.
 */

import type { Style } from '@/lib/db/schema/libraries';
import { parseStyleConfig } from '@/lib/style/style-config';
import { createSequenceLink, listStylesLink } from './discovery';
import { getLink, type HalResource, STYLES_PATH, withLinks } from './hal';

/** Compact card for the list endpoint. */
export type StyleCard = {
  id: string;
  name: string;
  category: string | null;
  tags: string[];
  isTemplate: boolean;
};

/** Full document for create/get. */
export type StyleDocument = StyleCard & {
  description: string | null;
  useCases: string[];
  defaultAspectRatio: string | null;
  recommendedImageModel: string | null;
  recommendedVideoModel: string | null;
  previewUrl: string | null;
  config: ReturnType<typeof parseStyleConfig>;
  createdAt: string;
};

export function styleCard(style: Style): HalResource<StyleCard> {
  return withLinks(
    {
      id: style.id,
      name: style.name,
      category: style.category,
      tags: style.tags ?? [],
      isTemplate: style.isTemplate ?? false,
    },
    { self: getLink(`${STYLES_PATH}/${style.id}`, 'Full style document') }
  );
}

export function styleDocument(style: Style): HalResource<StyleDocument> {
  const card = styleCard(style);
  return withLinks(
    {
      ...card,
      description: style.description,
      useCases: style.useCases ?? [],
      defaultAspectRatio: style.defaultAspectRatio,
      recommendedImageModel: style.recommendedImageModel,
      recommendedVideoModel: style.recommendedVideoModel,
      previewUrl: style.previewUrl,
      config: parseStyleConfig(style.config),
      createdAt: style.createdAt.toISOString(),
    },
    {
      ...card._links,
      'create-sequence': {
        ...createSequenceLink(),
        title: 'Create a video sequence in this style',
        examples: [
          {
            script: 'A lighthouse keeper befriends a stranded whale.',
            style: style.id,
          },
        ],
      },
      'list-styles': listStylesLink(),
    }
  );
}
