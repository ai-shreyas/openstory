/**
 * Scene Location Tab
 * Displays the location for the current shot with reference image and details
 */

import { Skeleton } from '@/components/ui/skeleton';
import { facetIdsForShots, useSceneFacetMaps } from '@/hooks/use-scene-facets';
import { useSequenceLocations } from '@/hooks/use-sequence-locations';
import { Link } from '@tanstack/react-router';
import { ExternalLink, MapPin } from 'lucide-react';
import { AppImage } from '@/components/ui/app-image';

type SceneLocationTabProps = {
  sequenceId: string;
  /** Shots in the current selection. `null` = whole sequence (show all). */
  shotIds: string[] | null;
};

type DetailRowProps = {
  label: string;
  value: string | null | undefined;
};

const DetailRow: React.FC<DetailRowProps> = ({ label, value }) => {
  if (!value) return null;

  return (
    <div className="space-y-1">
      <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="text-sm leading-relaxed">{value}</dd>
    </div>
  );
};

export const SceneLocationTab: React.FC<SceneLocationTabProps> = ({
  sequenceId,
  shotIds,
}) => {
  const { data: locations, isLoading } = useSequenceLocations(sequenceId);
  const { data: facetMaps } = useSceneFacetMaps(sequenceId);

  // Membership is resolved server-side (same match the render path uses); the
  // selection is applied here as a set lookup, not a re-derivation.
  const scopedIds = facetIdsForShots(facetMaps?.locationIdsByShot, shotIds);
  const scopedLocations = !locations
    ? []
    : scopedIds === null
      ? locations
      : locations.filter((l) => scopedIds.has(l.id));

  // Loading state
  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="aspect-video w-full rounded-lg" />
        <div className="space-y-3">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>
    );
  }

  if (scopedLocations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="mb-4 rounded-full bg-muted p-4">
          <MapPin className="h-8 w-8 text-muted-foreground/50" />
        </div>
        <p className="text-sm text-muted-foreground">
          {shotIds === null
            ? 'No locations yet'
            : 'No locations in this selection'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
        <span>{shotIds === null ? 'All Locations' : 'Locations'}</span>
        <span className="text-muted-foreground/50">·</span>
        <span>{scopedLocations.length}</span>
      </div>

      {scopedLocations.map((shotLocation) => (
        <div key={shotLocation.id} className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
              <span>{shotLocation.name}</span>
              {shotLocation.type && (
                <>
                  <span className="text-muted-foreground/50">·</span>
                  <span>
                    {shotLocation.type === 'interior'
                      ? 'Interior'
                      : shotLocation.type === 'exterior'
                        ? 'Exterior'
                        : 'Int/Ext'}
                  </span>
                </>
              )}
            </div>
            <Link
              to="/sequences/$id/locations/$locationId"
              params={{ id: sequenceId, locationId: shotLocation.id }}
              className="flex items-center gap-1 text-xs text-primary hover:underline"
            >
              View Details
              <ExternalLink className="h-3 w-3" />
            </Link>
          </div>

          <div className="relative aspect-video overflow-hidden rounded-lg bg-muted">
            {shotLocation.referenceImageUrl ? (
              <AppImage
                src={shotLocation.referenceImageUrl}
                alt={shotLocation.name}
                width={160}
                height={160}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-2">
                <MapPin className="h-12 w-12 text-muted-foreground/20" />
                <p className="text-xs text-muted-foreground">
                  {shotLocation.referenceStatus === 'generating'
                    ? 'Generating reference…'
                    : 'No reference image'}
                </p>
              </div>
            )}
            {shotLocation.type && shotLocation.referenceImageUrl && (
              <div className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-xs font-medium text-white">
                {shotLocation.type === 'interior'
                  ? 'INT'
                  : shotLocation.type === 'exterior'
                    ? 'EXT'
                    : 'INT/EXT'}
              </div>
            )}
          </div>

          <dl className="space-y-3">
            <DetailRow label="Description" value={shotLocation.description} />
            <div className="grid grid-cols-2 gap-3">
              <DetailRow label="Time of Day" value={shotLocation.timeOfDay} />
              <DetailRow
                label="Architectural Style"
                value={shotLocation.architecturalStyle}
              />
            </div>
            <DetailRow label="Key Features" value={shotLocation.keyFeatures} />
            {shotLocation.consistencyTag && (
              <div className="pt-2">
                <span className="rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
                  {shotLocation.consistencyTag}
                </span>
              </div>
            )}
          </dl>
        </div>
      ))}
    </div>
  );
};
