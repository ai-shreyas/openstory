import { LocationLibraryCard } from '@/components/location-library/location-library-card';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useLibraryLocationDivergentVariants } from '@/hooks/use-library-location-sheet-variants';
import { useLocationSheetsRealtime } from '@/hooks/use-location-sheets-realtime';
import type { LibraryLocation } from '@/lib/db/schema';
import { useMemo } from 'react';

type LocationLibraryListProps = {
  locations?: LibraryLocation[];
  isLoading?: boolean;
  error?: Error | null;
};

export const LocationLibraryList: React.FC<LocationLibraryListProps> = ({
  locations,
  isLoading,
  error,
}) => {
  // Subscribe to realtime events for all locations
  const locationIds = locations?.map((l) => l.id) ?? [];
  const { isGenerating } = useLocationSheetsRealtime(locationIds);

  const { data: divergentVariants } = useLibraryLocationDivergentVariants();
  const divergentByLocationId = useMemo(() => {
    const map = new Map<string, string>();
    for (const v of divergentVariants ?? []) {
      if (!map.has(v.parentId)) map.set(v.parentId, v.id);
    }
    return map;
  }, [divergentVariants]);

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
        {[1, 2, 3, 4, 5, 6].map((n) => (
          <Card key={`skeleton-${n}`} className="overflow-hidden animate-pulse">
            <div className="aspect-video bg-muted" />
            <div className="p-4">
              <div className="h-4 bg-muted rounded w-3/4 mb-2" />
              <div className="h-3 bg-muted rounded w-1/2" />
            </div>
          </Card>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <Card className="p-8 text-center">
        <p className="text-destructive mb-4">Failed to load locations</p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          Try Again
        </Button>
      </Card>
    );
  }

  if (!locations || locations.length === 0) {
    return null;
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
      {locations.map((location) => (
        <LocationLibraryCard
          key={location.id}
          location={location}
          isGenerating={isGenerating(location.id)}
          divergentVariantId={divergentByLocationId.get(location.id)}
        />
      ))}
    </div>
  );
};
