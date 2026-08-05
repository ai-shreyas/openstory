import { PageContainer } from '@/components/layout/page-container';
import { ModelCatalogView } from '@/components/models/model-catalog-view';
import { PageDescription } from '@/components/typography/page-description';
import { PageHeader } from '@/components/typography/page-header';
import { MODELS_ENABLED } from '@/lib/flags';
import { CATALOG_ACTIVITIES } from '@/lib/models/catalog';
import { createFileRoute, notFound, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';

// No `.default()` (mirrors the styles route): a default rewrites bare /models
// to a redirect, which sours the sitemap. Fallbacks live in the component.
const searchParamsSchema = z.object({
  activity: z.enum(CATALOG_ACTIVITIES).optional(),
  q: z.string().optional(),
});

export const Route = createFileRoute('/_app/models/')({
  beforeLoad: () => {
    if (!MODELS_ENABLED) throw notFound();
  },
  validateSearch: searchParamsSchema,
  component: ModelsPage,
  staticData: { breadcrumb: 'Models' },
});

function ModelsPage() {
  const { activity, q } = Route.useSearch();
  const navigate = useNavigate();

  return (
    <div className="h-full overflow-auto">
      <PageContainer maxWidth="wide">
        <h1 className="sr-only">Models</h1>
        <PageHeader>
          <PageDescription>
            Browse the full fal.ai model catalog — image, video, and audio. Open
            a model to see its parameters and run it directly.
          </PageDescription>
        </PageHeader>

        <ModelCatalogView
          activity={activity}
          q={q}
          onActivityChange={(next) =>
            void navigate({
              to: '/models',
              search: (prev) => ({ ...prev, activity: next }),
            })
          }
          onSearchChange={(next) =>
            void navigate({
              to: '/models',
              search: (prev) => ({ ...prev, q: next }),
            })
          }
        />
      </PageContainer>
    </div>
  );
}
