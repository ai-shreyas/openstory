import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import {
  type TeamLibraryLocation,
  useTeamLocationsLibrary,
} from '@/hooks/use-sequence-locations';
import { MapPin, Search } from 'lucide-react';
import { useState } from 'react';
import { AppImage } from '@/components/ui/app-image';

type LocationPickerDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (location: TeamLibraryLocation) => void;
  excludeLocationId?: string;
};

type LocationPickerCardProps = {
  location: TeamLibraryLocation;
  onClick: () => void;
};

const LocationPickerCard: React.FC<LocationPickerCardProps> = ({
  location,
  onClick,
}) => {
  const imageUrl = location.referenceImageUrl;

  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col items-center gap-2 rounded-lg p-3 text-center transition-colors hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary"
    >
      <div className="aspect-video w-full overflow-hidden rounded-lg bg-muted">
        {imageUrl ? (
          <AppImage
            src={imageUrl}
            alt={location.name}
            width={160}
            height={160}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <MapPin className="h-12 w-12 text-muted-foreground/30" />
          </div>
        )}
      </div>
      <span className="text-sm font-medium truncate w-full">
        {location.name}
      </span>
      <span className="text-xs text-muted-foreground truncate w-full">
        {location.sequenceTitle}
      </span>
    </button>
  );
};

export const LocationPickerDialog: React.FC<LocationPickerDialogProps> = ({
  open,
  onOpenChange,
  onSelect,
  excludeLocationId,
}) => {
  const { data: locationList, isLoading } = useTeamLocationsLibrary();
  const [searchQuery, setSearchQuery] = useState('');

  // Filter locations by search query and exclude current
  const filteredLocations = locationList?.filter((loc) => {
    if (excludeLocationId && loc.id === excludeLocationId) return false;
    if (!searchQuery) return true;
    const searchLower = searchQuery.toLowerCase();
    return (
      loc.name.toLowerCase().includes(searchLower) ||
      loc.sequenceTitle.toLowerCase().includes(searchLower) ||
      (loc.description?.toLowerCase().includes(searchLower) ?? false)
    );
  });

  const handleSelect = (location: TeamLibraryLocation) => {
    onSelect(location);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Select Location Reference</DialogTitle>
          <DialogDescription>
            Choose a location from your library to use as a visual reference.
          </DialogDescription>
        </DialogHeader>

        {/* Search input */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            placeholder="Search locations..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* Locations grid */}
        <ScrollArea className="h-[400px]">
          {isLoading ? (
            <div className="grid grid-cols-2 gap-4 p-1 sm:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex flex-col items-center gap-2 p-3">
                  <Skeleton className="aspect-video w-full rounded-lg" />
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              ))}
            </div>
          ) : !filteredLocations || filteredLocations.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center py-12 text-center">
              <MapPin className="h-12 w-12 text-muted-foreground/30" />
              <p className="mt-4 text-sm text-muted-foreground">
                {searchQuery
                  ? 'No locations matching your search'
                  : 'No locations available'}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Locations from other sequences will appear here
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4 p-1 sm:grid-cols-3">
              {filteredLocations.map((location) => (
                <LocationPickerCard
                  key={location.id}
                  location={location}
                  onClick={() => handleSelect(location)}
                />
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
};
