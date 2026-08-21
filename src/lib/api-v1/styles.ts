/**
 * Public `/api/v1/styles` documents (#1227). Create goes straight through
 * `scopedDb.styles.create` (slug-unique per team, server-managed columns
 * stripped); this module only shapes the HAL responses.
 */

import type { Style } from '@/lib/db/schema/libraries';
import { parseStyleConfig } from '@/lib/style/style-config';
import { createSequenceLink } from './discovery';
import { getLink, STYLES_PATH, withLinks } from './hal';

export function styleDocument(style: Style) {
  return withLinks(
    {
      id: style.id,
      name: style.name,
      description: style.description,
      category: style.category,
      tags: style.tags ?? [],
      useCases: style.useCases ?? [],
      isTemplate: style.isTemplate ?? false,
      defaultAspectRatio: style.defaultAspectRatio,
      recommendedImageModel: style.recommendedImageModel,
      recommendedVideoModel: style.recommendedVideoModel,
      previewUrl: style.previewUrl,
      config: parseStyleConfig(style.config),
      createdAt: style.createdAt.toISOString(),
    },
    {
      self: getLink(`${STYLES_PATH}/${style.id}`, 'Full style document'),
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
      'list-styles': getLink(STYLES_PATH, "List your team's library styles"),
    }
  );
}
