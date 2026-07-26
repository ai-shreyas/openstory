import type { Shot } from '@/types/database';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ShotVariant } from '@/lib/db/schema';
import type { ImageVariantWithShot } from '@/lib/db/scoped/frame-variants';
import type { ShotWithImage } from '@/lib/shots/shot-with-image';
import {
  getShotsFn,
  getDivergentVariantsFn,
  promoteVariantFn,
  discardVariantFn,
  undiscardVariantFn,
  getSequenceImageModelsFn,
  getSequenceImageVariantsFn,
  getSequenceSelectedModelsFn,
  getSequenceVideoModelsFn,
  getSequenceVideoVariantsFn,
} from '@/functions/shots';
import {
  generateShotVariantsFn,
  selectShotVariantFn,
  setImageFromVariantFn,
  setVideoFromVariantFn,
} from '@/functions/shot-image';
import type { GenerateVariantInput as SchemaGenerateVariantInput } from '@/lib/schemas/shot.schemas';

type GenerateVariantInput = SchemaGenerateVariantInput & {
  sequenceId: string;
  shotId: string;
};

type SelectVariantInput = {
  sequenceId: string;
  shotId: string;
  variantIndex: number;
};

// Query keys
export const shotKeys = {
  all: ['shots'] as const,
  lists: () => [...shotKeys.all, 'list'] as const,
  list: (sequenceId: string) => [...shotKeys.lists(), sequenceId] as const,
  details: () => [...shotKeys.all, 'detail'] as const,
  detail: (id: string) => [...shotKeys.details(), id] as const,
  divergentVariants: (sequenceId: string) =>
    [...shotKeys.all, 'divergent-variants', sequenceId] as const,
};

// Distinct image models that have generated a variant for this sequence.
// Drives the header image-model dropdown (#547). Flat key matches the
// image:progress cache invalidation in query-cache-updater.
export function useSequenceImageModels(sequenceId?: string) {
  return useQuery<string[]>({
    queryKey: ['sequence-image-models', sequenceId ?? ''],
    queryFn: async () => {
      if (!sequenceId) throw new Error('sequenceId is required');
      return getSequenceImageModelsFn({ data: { sequenceId } });
    },
    enabled: !!sequenceId,
    staleTime: 30_000,
  });
}

// Distinct video models that have generated a variant for this sequence (#545).
// Drives the header video-model dropdown. The realtime video:progress handler
// invalidates `['sequence-video-models', sequenceId]`, matching this key's tail.
export function useSequenceVideoModels(sequenceId?: string) {
  return useQuery<string[]>({
    queryKey: ['sequence-video-models', sequenceId ?? ''],
    queryFn: async () => {
      if (!sequenceId) throw new Error('sequenceId is required');
      return getSequenceVideoModelsFn({ data: { sequenceId } });
    },
    enabled: !!sequenceId,
    staleTime: 30_000,
  });
}

// All video ShotVariant rows for a sequence (#545). Used by the scenes view to
// resolve each shot's displayed video through the active model's variant.
export function useSequenceVideoVariants(sequenceId?: string) {
  return useQuery<ShotVariant[]>({
    queryKey: ['sequence-video-variants', sequenceId ?? ''],
    queryFn: async () => {
      if (!sequenceId) throw new Error('sequenceId is required');
      return getSequenceVideoVariantsFn({ data: { sequenceId } });
    },
    enabled: !!sequenceId,
    staleTime: 30_000,
  });
}

// All image FrameVariant (kind:'model') rows for a sequence (#547/#989), each
// carrying its owning `shotId` (frame ids ≠ shot ids). Used by the header image
// dropdown for sequence-wide per-model coverage, and by the scenes view to
// resolve each shot's displayed image through the active model's variant.
export function useSequenceImageVariants(sequenceId?: string) {
  return useQuery<ImageVariantWithShot[]>({
    queryKey: ['sequence-image-variants', sequenceId ?? ''],
    queryFn: async () => {
      if (!sequenceId) throw new Error('sequenceId is required');
      return getSequenceImageVariantsFn({ data: { sequenceId } });
    },
    enabled: !!sequenceId,
    staleTime: 30_000,
  });
}

// The model recorded on each shot's selected image / video version (#1066).
// Model identity lives on the version that produced the asset, so this is what
// the editor resolves its displayed / generated-with model from. Invalidated by
// the realtime image:progress + video:progress handlers, since a completed
// convergent render repoints the selection.
export function useSequenceSelectedModels(sequenceId?: string) {
  return useQuery({
    // Flat key, matching the sibling per-model queries — the realtime
    // image/video progress handlers invalidate this exact shape.
    queryKey: ['sequence-selected-models', sequenceId ?? ''],
    queryFn: async () => {
      if (!sequenceId) throw new Error('sequenceId is required');
      return getSequenceSelectedModelsFn({ data: { sequenceId } });
    },
    enabled: !!sequenceId,
    staleTime: 30_000,
  });
}

// Hook to fetch the live (non-discarded) divergent alternates for a sequence.
// The corner-dot indicator and inline banner both filter this list per shot.
export function useDivergentVariants(
  sequenceId?: string,
  options?: { refetchInterval?: number | false }
) {
  return useQuery<ShotVariant[]>({
    queryKey: shotKeys.divergentVariants(sequenceId ?? ''),
    queryFn: async () => {
      if (!sequenceId) throw new Error('sequenceId is required');
      return getDivergentVariantsFn({ data: { sequenceId } });
    },
    enabled: !!sequenceId,
    staleTime: 30_000,
    refetchInterval: options?.refetchInterval ?? false,
  });
}

// Promote a divergent alternate to the live primary slot.
export function usePromoteVariantToPrimary() {
  const queryClient = useQueryClient();
  return useMutation<
    { shot: Shot; variantId: string },
    Error,
    { sequenceId: string; shotId: string; variantId: string }
  >({
    mutationFn: async (input) => {
      const result = await promoteVariantFn({ data: input });
      return result;
    },
    onSuccess: async ({ shot }, { sequenceId }) => {
      queryClient.setQueryData(shotKeys.detail(shot.id), shot);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: shotKeys.list(sequenceId),
        }),
        queryClient.invalidateQueries({
          queryKey: shotKeys.divergentVariants(sequenceId),
        }),
        queryClient.invalidateQueries({
          queryKey: ['sequence-image-variants', sequenceId],
        }),
      ]);
    },
  });
}

// Discard a divergent alternate (sets discarded_at). Pairs with useUndiscard
// for the toast Undo action.
export function useDiscardVariant() {
  const queryClient = useQueryClient();
  return useMutation<
    { variantId: string; discardedAt: Date },
    Error,
    { sequenceId: string; shotId: string; variantId: string }
  >({
    mutationFn: async (input) => discardVariantFn({ data: input }),
    onSuccess: async (_, { sequenceId }) => {
      await queryClient.invalidateQueries({
        queryKey: shotKeys.divergentVariants(sequenceId),
      });
    },
  });
}

export function useUndiscardVariant() {
  const queryClient = useQueryClient();
  return useMutation<
    { variantId: string },
    Error,
    { sequenceId: string; shotId: string; variantId: string }
  >({
    mutationFn: async (input) => undiscardVariantFn({ data: input }),
    onSuccess: async (_, { sequenceId }) => {
      await queryClient.invalidateQueries({
        queryKey: shotKeys.divergentVariants(sequenceId),
      });
    },
  });
}

// Hook for listing shots by sequence with optional auto-refresh
export function useShotsBySequence(
  sequenceId?: string,
  options?: {
    refetchInterval?: number | false;
    staleTime?: number;
  }
) {
  return useQuery<ShotWithImage[]>({
    queryKey: shotKeys.list(sequenceId ?? ''),
    queryFn: async () => {
      if (!sequenceId) throw new Error('sequenceId is required');
      const data = await getShotsFn({ data: { sequenceId } });
      return data;
    },
    staleTime: options?.staleTime ?? 30_000, // Realtime events update the cache; polling is a fallback
    // Callers pass an explicit refetchInterval when needed (e.g. scenes-view
    // passes 2000 when realtime has failed). No default polling — realtime
    // events keep the cache fresh via updateQueryCacheFromEvent.
    refetchInterval: options?.refetchInterval ?? false,
    refetchOnMount: 'always', // Always refetch on mount to ensure fresh data
    refetchOnWindowFocus: true, // Refetch when window regains focus
    enabled: !!sequenceId,
  });
}

// Hook for generating variant images for a shot
export function useGenerateVariants() {
  const queryClient = useQueryClient();

  return useMutation<{ workflowRunId: string }, Error, GenerateVariantInput>({
    mutationFn: async (input: GenerateVariantInput) => {
      const { sequenceId, shotId, model, imageSize, numImages, seed } = input;

      const result = await generateShotVariantsFn({
        data: {
          sequenceId,
          shotId,
          model,
          imageSize,
          numImages,
          seed,
        },
      });

      return { workflowRunId: result.workflowRunId };
    },
    onSuccess: async (_, { sequenceId, shotId }) => {
      // Optimistically update shot status to 'generating'
      queryClient.setQueryData<ShotWithImage>(
        shotKeys.detail(shotId),
        (oldShot) => {
          if (!oldShot) return oldShot;
          return {
            ...oldShot,
            variantImageStatus: 'generating' as const,
          };
        }
      );

      queryClient.setQueryData<ShotWithImage[]>(
        shotKeys.list(sequenceId),
        (oldShots) => {
          if (!oldShots) return oldShots;
          return oldShots.map((f) =>
            f.id === shotId
              ? {
                  ...f,
                  variantImageStatus: 'generating' as const,
                }
              : f
          );
        }
      );

      // Invalidate queries to pick up server updates
      await queryClient.invalidateQueries({
        queryKey: shotKeys.detail(shotId),
      });

      await queryClient.invalidateQueries({
        queryKey: shotKeys.list(sequenceId),
      });
    },
  });
}

// Hook for selecting a variant panel and upscaling it
export function useSelectVariant() {
  const queryClient = useQueryClient();

  return useMutation<
    { shotId: string; thumbnailUrl: string; variantIndex: number },
    Error,
    SelectVariantInput
  >({
    mutationFn: async (input: SelectVariantInput) => {
      const { sequenceId, shotId, variantIndex } = input;
      const result = await selectShotVariantFn({
        data: {
          sequenceId,
          shotId,
          variantIndex,
        },
      });

      return {
        shotId: result.shotId,
        thumbnailUrl: result.thumbnailUrl,
        variantIndex: result.variantIndex,
      };
    },
    onSuccess: async (data, { sequenceId, shotId }) => {
      // Update shot queries with new thumbnail
      queryClient.setQueryData<ShotWithImage>(
        shotKeys.detail(shotId),
        (oldShot) => {
          if (!oldShot) return oldShot;
          return {
            ...oldShot,
            thumbnailUrl: data.thumbnailUrl,
            thumbnailStatus: 'generating' as const, // Upscale is running
          };
        }
      );

      queryClient.setQueryData<ShotWithImage[]>(
        shotKeys.list(sequenceId),
        (oldShots) => {
          if (!oldShots) return oldShots;
          return oldShots.map((f) =>
            f.id === shotId
              ? {
                  ...f,
                  thumbnailUrl: data.thumbnailUrl,
                  thumbnailStatus: 'generating' as const,
                }
              : f
          );
        }
      );

      // Invalidate queries to ensure consistency
      await queryClient.invalidateQueries({
        queryKey: shotKeys.detail(shotId),
      });

      await queryClient.invalidateQueries({
        queryKey: shotKeys.list(sequenceId),
      });
    },
  });
}

// Hook for setting a shot's image from an existing variant
export function useSetImageFromVariant() {
  const queryClient = useQueryClient();

  return useMutation<
    // thumbnailUrl mirrors the selected frame variant's `imageUrl`, which is
    // nullable until the image completes (#989).
    { shotId: string; thumbnailUrl: string | null },
    Error,
    { sequenceId: string; shotId: string; model: string }
  >({
    mutationFn: async (input) => {
      return setImageFromVariantFn({ data: input });
    },
    onMutate: async ({ sequenceId, shotId }) => {
      await queryClient.cancelQueries({
        queryKey: shotKeys.detail(shotId),
      });
      await queryClient.cancelQueries({
        queryKey: shotKeys.list(sequenceId),
      });
    },
    onSuccess: async (data, { sequenceId, shotId, model }) => {
      queryClient.setQueryData<ShotWithImage>(
        shotKeys.detail(shotId),
        (oldShot) => {
          if (!oldShot) return oldShot;
          return {
            ...oldShot,
            thumbnailUrl: data.thumbnailUrl,
            thumbnailStatus: 'completed' as const,
            imageModel: model,
            videoUrl: null,
            videoStatus: 'pending' as const,
          };
        }
      );

      queryClient.setQueryData<ShotWithImage[]>(
        shotKeys.list(sequenceId),
        (oldShots) => {
          if (!oldShots) return oldShots;
          return oldShots.map((f) =>
            f.id === shotId
              ? {
                  ...f,
                  thumbnailUrl: data.thumbnailUrl,
                  thumbnailStatus: 'completed' as const,
                  imageModel: model,
                  videoUrl: null,
                  videoStatus: 'pending' as const,
                }
              : f
          );
        }
      );

      await queryClient.invalidateQueries({
        queryKey: shotKeys.detail(shotId),
      });
      await queryClient.invalidateQueries({
        queryKey: shotKeys.list(sequenceId),
      });
      // This repointed `frames.selectedImageVersionId`, which is what the
      // editor resolves its model from (#1066). Without this the dropdown keeps
      // the pre-Set model AND sends it as the explicit model on the next
      // generation — a billed render in the model just replaced.
      await queryClient.invalidateQueries({
        queryKey: ['sequence-selected-models', sequenceId],
      });
    },
  });
}

// Hook for setting a shot's video from an existing variant (#545) — the
// motion analog of useSetImageFromVariant. Promotes a model's video variant to
// the primary shots.video* columns and refreshes the video-variant cache.
export function useSetVideoFromVariant() {
  const queryClient = useQueryClient();

  return useMutation<
    { shotId: string; videoUrl: string },
    Error,
    { sequenceId: string; shotId: string; model: string }
  >({
    mutationFn: async (input) => {
      return setVideoFromVariantFn({ data: input });
    },
    onMutate: async ({ sequenceId, shotId }) => {
      await queryClient.cancelQueries({
        queryKey: shotKeys.detail(shotId),
      });
      await queryClient.cancelQueries({
        queryKey: shotKeys.list(sequenceId),
      });
    },
    onSuccess: async (data, { sequenceId, shotId, model }) => {
      queryClient.setQueryData<ShotWithImage>(
        shotKeys.detail(shotId),
        (oldShot) => {
          if (!oldShot) return oldShot;
          return {
            ...oldShot,
            videoUrl: data.videoUrl,
            videoStatus: 'completed' as const,
            motionModel: model,
          };
        }
      );

      queryClient.setQueryData<ShotWithImage[]>(
        shotKeys.list(sequenceId),
        (oldShots) => {
          if (!oldShots) return oldShots;
          return oldShots.map((f) =>
            f.id === shotId
              ? {
                  ...f,
                  videoUrl: data.videoUrl,
                  videoStatus: 'completed' as const,
                  motionModel: model,
                }
              : f
          );
        }
      );

      await queryClient.invalidateQueries({
        queryKey: shotKeys.detail(shotId),
      });
      await queryClient.invalidateQueries({
        queryKey: shotKeys.list(sequenceId),
      });
      await queryClient.invalidateQueries({
        queryKey: ['sequence-video-variants', sequenceId],
      });
      // Repointed the segment's `selectedVideoVersionId` — the editor's model
      // source (#1066). See useSetImageFromVariant for why this matters.
      await queryClient.invalidateQueries({
        queryKey: ['sequence-selected-models', sequenceId],
      });
    },
  });
}
