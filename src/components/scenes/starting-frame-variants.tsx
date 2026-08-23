import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useFalBillingGate } from '@/hooks/use-billing-gate';
import { useGenerateVariants, useSelectVariant } from '@/hooks/use-shots';
import { useVariantUpscalePreview } from '@/hooks/use-variant-upscale-preview';
import type { TextToImageModel } from '@/lib/ai/models';
import {
  type AspectRatio,
  getVariantGridConfig,
} from '@/lib/constants/aspect-ratios';
import { tileBackgroundCss } from '@/lib/image/tile-crop';
import {
  clearVariantUpscalePreview,
  setVariantUpscalePreview,
} from '@/lib/shots/variant-upscale-preview';
import type { ShotView } from '@/lib/shots/shot-view';
import { useQueryClient } from '@tanstack/react-query';
import { Grid2x2, Loader2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { VariantSelector } from './variant-selector';

type StartingFrameVariantsProps = {
  shot: ShotView;
  sequenceId: string;
  /** Scene-level image model (#909) the variants are generated with. */
  imageModel: TextToImageModel;
  aspectRatio: AspectRatio;
  /** Optimistic generating flag shared with the rest of the app (#882). */
  generating: boolean;
  onGenerateStart: () => void;
};

/**
 * A "Variants" control overlaid on the starting frame (#986). Replaces the old
 * Variants tab: the button lives on the canvas image, and clicking it opens a
 * dialog with the variant grid so the alternates have room to display at full
 * aspect ratio. Selecting a tile promotes it to the shot's starting frame.
 */
export const StartingFrameVariants: React.FC<StartingFrameVariantsProps> = ({
  shot,
  sequenceId,
  imageModel,
  aspectRatio,
  generating,
  onGenerateStart,
}) => {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const upscale = useVariantUpscalePreview(shot.id);
  const generateVariants = useGenerateVariants();
  const selectVariant = useSelectVariant();
  const { needsBillingSetup: falNeedsBillingSetup, showGate: showFalGate } =
    useFalBillingGate();

  const isGeneratingGrid =
    generating ||
    shot.gridSheet?.status === 'generating' ||
    generateVariants.isPending;
  const upscalingIndex = upscale?.variantIndex ?? null;
  const cropUrl = shot.pendingUpscaleUrl;
  const isUpscaling =
    upscale !== null || selectVariant.isPending || Boolean(cropUrl);

  const handleGenerate = useCallback(async () => {
    onGenerateStart();
    clearVariantUpscalePreview(queryClient, shot.id);
    try {
      await generateVariants.mutateAsync({
        sequenceId,
        shotId: shot.id,
        model: imageModel,
      });
    } catch (error) {
      toast.error('Scene variants generation failed', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }, [
    onGenerateStart,
    generateVariants,
    sequenceId,
    shot.id,
    imageModel,
    queryClient,
  ]);

  const handleSelect = useCallback(
    async (index: number) => {
      // Close immediately (#1193). Persist the picked cell on the QueryClient
      // so navigating away and back still shows the lo-res tile + Upscaling.
      if (shot.gridSheet?.url) {
        setVariantUpscalePreview(queryClient, shot.id, {
          variantIndex: index,
          gridUrl: shot.gridSheet.url,
          aspectRatio,
        });
      }
      setOpen(false);
      try {
        await selectVariant.mutateAsync({
          sequenceId,
          shotId: shot.id,
          variantIndex: index,
          aspectRatio,
        });
      } catch (error) {
        toast.error('Failed to select variant', {
          description: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    },
    [
      selectVariant,
      sequenceId,
      shot.id,
      shot.gridSheet?.url,
      aspectRatio,
      queryClient,
    ]
  );

  const gridConfig = getVariantGridConfig(upscale?.aspectRatio ?? aspectRatio);
  const upscalingTileCss =
    upscalingIndex !== null
      ? tileBackgroundCss({
          index: upscalingIndex,
          gridCols: gridConfig.cols,
          gridRows: gridConfig.rows,
        })
      : null;

  return (
    <>
      {isUpscaling && (upscalingTileCss || cropUrl) && (
        <div
          className="absolute inset-0 z-[6] overflow-hidden"
          aria-live="polite"
          aria-label="Upscaling selected variant"
        >
          {upscalingIndex !== null && upscale?.gridUrl && upscalingTileCss ? (
            <div
              className="absolute inset-0"
              style={{
                backgroundImage: `url(${upscale.gridUrl})`,
                backgroundRepeat: 'no-repeat',
                ...upscalingTileCss,
              }}
            />
          ) : cropUrl ? (
            <div
              className="absolute inset-0 bg-cover bg-center"
              style={{ backgroundImage: `url(${cropUrl})` }}
            />
          ) : null}
          <div className="pointer-events-none absolute inset-x-0 bottom-2 z-[7] flex justify-center">
            <span className="flex items-center gap-1.5 rounded-full bg-background/80 px-3 py-1 text-xs font-medium text-foreground backdrop-blur-sm">
              <Loader2 className="h-3 w-3 animate-spin" />
              Upscaling…
            </span>
          </div>
        </div>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        className="absolute top-2 left-2 z-10 h-8 gap-1.5 bg-black/50 px-2 text-xs text-white hover:bg-black/70"
        aria-label={isUpscaling ? 'Upscaling frame variant' : 'Frame variants'}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-busy={isUpscaling || isGeneratingGrid}
      >
        {isGeneratingGrid || isUpscaling ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Grid2x2 className="h-4 w-4" />
        )}
        {isUpscaling
          ? 'Upscaling…'
          : isGeneratingGrid
            ? 'Generating…'
            : 'Frame variants'}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Frame variants</DialogTitle>
            <DialogDescription>
              Pick an alternate for this shot&apos;s starting frame, or generate
              a new set.
            </DialogDescription>
          </DialogHeader>

          {shot.gridSheet?.url ? (
            <VariantSelector
              variantImageUrl={shot.gridSheet.url}
              selectedVariantIndex={upscalingIndex}
              onVariantSelect={(index) => void handleSelect(index)}
              loading={isUpscaling}
              disabled={isGeneratingGrid}
              aspectRatio={aspectRatio}
            />
          ) : (
            <div className="rounded-lg border border-dashed border-muted-foreground/30 p-6 text-center text-sm text-muted-foreground">
              No variants yet. Generate options for this starting frame.
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              onClick={() => {
                if (falNeedsBillingSetup) {
                  showFalGate();
                  return;
                }
                void handleGenerate();
              }}
              disabled={isGeneratingGrid}
              className="w-full sm:w-auto"
            >
              {isGeneratingGrid && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {isGeneratingGrid
                ? 'Generating…'
                : shot.gridSheet?.url
                  ? 'Regenerate frame variants'
                  : 'Generate frame variants'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
