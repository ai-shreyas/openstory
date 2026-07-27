import { StalenessIndicator } from '@/components/staleness/staleness-indicator';
import { useShotStaleness } from '@/hooks/use-shot-staleness';

type ShotStalenessBannersProps = {
  shotId?: string;
  sequenceId: string;
  onRegenerate: () => void;
  /**
   * Image regen already in flight (optimistic local set or server
   * `thumbnailStatus === 'generating'`). Hides the stale-image banner so
   * "Inputs changed" doesn't linger over a regenerating still.
   */
  isRegenerating?: boolean;
  // Retained for API stability. Image divergence is retired (#989) — image
  // variants live in `frame_variants` with selection as a pointer, so there is
  // no divergent image alternate to compare/promote/discard here anymore.
  onCompareDivergent?: (variantId: string) => void;
  onPromoteDivergent?: (variantId: string) => void;
  onDiscardDivergent?: (variantId: string) => void;
};

/**
 * Surfaces the Stage 1 staleness signal for the currently selected shot. The
 * staleness indicator queries the scoped `isStale` helper and renders at most
 * once so the panel stays calm.
 *
 * The image divergent-alternate banner that used to live here is gone: image
 * divergence was retired in #989 (selection is now a pointer repoint, not a
 * divergent alternate), so `frame_variants` never produce a divergent image to
 * surface. The reusable banner component still drives video/other divergence
 * elsewhere.
 */
export const ShotStalenessBanners: React.FC<ShotStalenessBannersProps> = ({
  shotId,
  sequenceId,
  onRegenerate,
  isRegenerating = false,
}) => {
  const { data: staleness } = useShotStaleness({ sequenceId, shotId });

  if (!shotId) return null;

  // Once regenerate is in flight the stale warning is obsolete — the main
  // Generate button already shows Generating… (#1070).
  if (isRegenerating) return null;

  // Suppress the thumbnail banner when the visual prompt is also stale: the
  // visual-prompt banner inside the Image tab is the prerequisite action
  // (regenerating the image from a stale prompt would just produce another
  // stale image), and showing both at once is redundant.
  if (staleness?.thumbnail === 'stale' && staleness.visualPrompt !== 'stale') {
    return (
      <StalenessIndicator
        artifact="thumbnail"
        entityType="shot"
        onRegenerate={onRegenerate}
        isRegenerating={isRegenerating}
      />
    );
  }

  return null;
};
