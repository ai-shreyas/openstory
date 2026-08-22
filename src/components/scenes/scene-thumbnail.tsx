import { BlobLoaderContainer } from '@/components/ui/blob-loader';
import {
  type AspectRatio,
  getAspectRatioClassName,
  getVariantGridConfig,
} from '@/lib/constants/aspect-ratios';
import { tileBackgroundCss } from '@/lib/image/tile-crop';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { AlertCircle, Loader2 } from 'lucide-react';
import { AppImage } from '@/components/ui/app-image';
import { memo } from 'react';

type SceneThumbnailProps = {
  thumbnailUrl?: string | null;
  previewThumbnailUrl?: string | null;
  thumbnailStatus?: 'pending' | 'generating' | 'completed' | 'failed';
  alt: string;
  aspectRatio: AspectRatio;
  className?: string;
  /** In-flight variant upscale — CSS-crop this cell over the still. */
  upscalePreview?: { gridUrl: string; variantIndex: number } | null;
};

const SceneThumbnailComponent: React.FC<SceneThumbnailProps> = ({
  thumbnailUrl,
  previewThumbnailUrl,
  thumbnailStatus,
  alt,
  aspectRatio,
  className,
  upscalePreview,
}) => {
  // Display the final image if available, otherwise the preview
  const displayUrl = thumbnailUrl ?? previewThumbnailUrl;
  const isPreview = !thumbnailUrl && !!previewThumbnailUrl;

  // Only show loader when there's no image at all
  const showLoader =
    !displayUrl && !!thumbnailStatus && thumbnailStatus !== 'failed';

  const showSkeleton = !displayUrl && !thumbnailStatus;
  const isFailed = thumbnailStatus === 'failed' && !displayUrl;
  const grid = getVariantGridConfig(aspectRatio);
  const upscaleCss = upscalePreview
    ? tileBackgroundCss({
        index: upscalePreview.variantIndex,
        gridCols: grid.cols,
        gridRows: grid.rows,
      })
    : null;

  return (
    <div
      className={cn(
        'relative overflow-hidden',
        getAspectRatioClassName(aspectRatio),
        className
      )}
    >
      {showSkeleton && (
        <Skeleton className="absolute h-full w-full rounded-md" />
      )}
      {showLoader && (
        <BlobLoaderContainer size="sm" className="absolute inset-0" />
      )}

      {displayUrl && !upscalePreview && (
        <AppImage
          src={displayUrl}
          alt={alt}
          className="h-full w-full object-cover"
          width={320}
          height={180}
        />
      )}

      {upscalePreview && upscaleCss && (
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: `url(${upscalePreview.gridUrl})`,
            backgroundRepeat: 'no-repeat',
            ...upscaleCss,
          }}
        />
      )}

      {isPreview && (
        <span className="absolute top-1 right-1 rounded bg-background/80 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground backdrop-blur-sm">
          Preview
        </span>
      )}

      {(upscalePreview || (displayUrl && thumbnailStatus === 'generating')) && (
        <span className="absolute inset-x-0 bottom-1 z-10 flex justify-center">
          <span className="flex items-center gap-1 rounded bg-background/80 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground backdrop-blur-sm">
            <Loader2 className="h-3 w-3 animate-spin" />
            Upscaling…
          </span>
        </span>
      )}

      {isFailed && (
        <div className="absolute inset-0 flex items-center justify-center bg-muted">
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <AlertCircle className="h-6 w-6" />
            <span className="text-xs">Failed to generate</span>
          </div>
        </div>
      )}
    </div>
  );
};

const areEqual = (
  prevProps: SceneThumbnailProps,
  nextProps: SceneThumbnailProps
): boolean => {
  return (
    prevProps.thumbnailUrl === nextProps.thumbnailUrl &&
    prevProps.previewThumbnailUrl === nextProps.previewThumbnailUrl &&
    prevProps.thumbnailStatus === nextProps.thumbnailStatus &&
    prevProps.alt === nextProps.alt &&
    prevProps.aspectRatio === nextProps.aspectRatio &&
    prevProps.className === nextProps.className &&
    prevProps.upscalePreview?.gridUrl === nextProps.upscalePreview?.gridUrl &&
    prevProps.upscalePreview?.variantIndex ===
      nextProps.upscalePreview?.variantIndex
  );
};

export const SceneThumbnail = memo(SceneThumbnailComponent, areEqual);
