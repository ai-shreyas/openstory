import {
  type VariantUpscalePreview,
  variantUpscaleKeys,
} from '@/lib/shots/variant-upscale-preview';
import { useQuery } from '@tanstack/react-query';

/**
 * Subscribe to the in-flight variant-upscale preview for a shot. Data is
 * written with `setVariantUpscalePreview` — this query never fetches.
 */
export function useVariantUpscalePreview(
  shotId: string | undefined
): VariantUpscalePreview | null {
  const { data } = useQuery<VariantUpscalePreview | null>({
    queryKey: variantUpscaleKeys.shot(shotId ?? ''),
    queryFn: async () => null,
    enabled: false,
    staleTime: Infinity,
    gcTime: 60 * 60 * 1000,
  });
  return data ?? null;
}
