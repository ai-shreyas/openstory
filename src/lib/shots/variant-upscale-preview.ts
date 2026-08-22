import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import type { QueryClient } from '@tanstack/react-query';

/**
 * In-flight variant upscale, keyed by shot. Lives in the QueryClient so it
 * survives shot switches, tab changes, and remounts — local React state does
 * not. Cleared when the upscale SSE completes or fails, or when the select
 * mutation errors.
 */
export const variantUpscaleKeys = {
  all: ['variant-upscale'] as const,
  shot: (shotId: string) => [...variantUpscaleKeys.all, shotId] as const,
};

export type VariantUpscalePreview = {
  variantIndex: number;
  gridUrl: string;
  aspectRatio: AspectRatio;
};

export function setVariantUpscalePreview(
  queryClient: QueryClient,
  shotId: string,
  preview: VariantUpscalePreview
): void {
  queryClient.setQueryData(variantUpscaleKeys.shot(shotId), preview);
}

export function clearVariantUpscalePreview(
  queryClient: QueryClient,
  shotId: string
): void {
  queryClient.setQueryData(variantUpscaleKeys.shot(shotId), null);
}

export function getVariantUpscalePreview(
  queryClient: QueryClient,
  shotId: string
): VariantUpscalePreview | null {
  return (
    queryClient.getQueryData<VariantUpscalePreview | null>(
      variantUpscaleKeys.shot(shotId)
    ) ?? null
  );
}
