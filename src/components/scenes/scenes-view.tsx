import { GenerationProgressBanner } from '@/components/generation/generation-progress-banner';
import { MotionProgressBanner } from '@/components/generation/motion-progress-banner';
import { type ModelGenerationStatus } from '@/components/model/base-model-selector';
import { ScenePlayer } from '@/components/motion/scene-player';
import { DivergenceCompareDialog } from '@/components/scenes/divergence-compare-dialog';
import { MobileSceneDrawer } from '@/components/scenes/mobile-scene-drawer';
import type { BatchGenerateMotionArgs } from '@/components/scenes/scene-list';
import { SceneList } from '@/components/scenes/scene-list';
import {
  SceneScriptPrompts,
  type TabValue,
} from '@/components/scenes/scene-script-prompts';
import { FailureSummaryBanner } from '@/components/sequence/failure-summary-banner';
import { ScrollArea } from '@/components/ui/scroll-area';
import { batchGenerateMotionFn } from '@/functions/motion-functions';
import { getDivergentVariantPromptDiffFn } from '@/functions/prompt-variants';
import { getSequenceImageVariantsFn } from '@/functions/shots';
import { smartRetryFn } from '@/functions/smart-retry';
import { useActiveImageModel } from '@/hooks/use-active-image-model';
import { useActiveVideoModel } from '@/hooks/use-active-video-model';
import { BILLING_BALANCE_KEY } from '@/hooks/use-billing-balance';
import { useScenesBySequence } from '@/hooks/use-scenes';
import { sequenceKeys, useSequence } from '@/hooks/use-sequences';
import {
  shotKeys,
  useDiscardVariant,
  useDivergentVariants,
  usePromoteVariantToPrimary,
  useSequenceSelectedModels,
  useSequenceVideoVariants,
  useShotsBySequence,
  useUndiscardVariant,
} from '@/hooks/use-shots';
import { useStyle } from '@/hooks/use-styles';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MUSIC_MODEL,
  DEFAULT_VIDEO_MODEL,
  IMAGE_MODELS,
  isValidTextToImageModel,
  safeAudioModel,
  safeImageToVideoModel,
  safeTextToImageModel,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import {
  resolveImageModel,
  resolveVideoModel,
} from '@/lib/ai/resolve-asset-models';
import {
  DEFAULT_ASPECT_RATIO,
  type AspectRatio,
} from '@/lib/constants/aspect-ratios';
import type { FrameVariant, SceneRow, ShotVariant } from '@/lib/db/schema';
import type { ImageVariantWithShot } from '@/lib/db/scoped/frame-variants';
import type { ShotWithImage } from '@/lib/shots/shot-with-image';
import { analyzeFailures } from '@/lib/failures/failure-analysis';
import type { GenerationPhaseConfig } from '@/lib/realtime/generation-stream.reducer';
import { useGenerationStream } from '@/lib/realtime/use-generation-stream';
import { useStaleDetected } from '@/lib/realtime/use-stale-detected';
import type { Sequence } from '@/types/database';
import { usePostHog } from '@posthog/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

/**
 * Minimal coverage row shared by video (`shot_variants`) and image
 * (`frame_variants`, #989) variants. Image variants have no `divergedAt`
 * (divergence is retired for images), so it's optional and treated as never
 * divergent.
 */
type SceneModelVariant = {
  model: string;
  status: ShotVariant['status'];
  url: string | null;
  discardedAt: Date | null;
  divergedAt?: Date | null;
};

/**
 * Per-model generation status across a scene's shots (#909) — feeds the scene
 * bar's ✓/⟳/! dropdown markers. The model the selected shot currently resolves
 * to (#1066) is marked `set`; completed wins over in-flight/failed.
 * Divergent/discarded alternates ignored.
 */
function buildSceneModelStatuses<V extends SceneModelVariant>(
  variantsByShot: Map<string, V[]>,
  shotIds: ReadonlySet<string>,
  setModel: string
): Map<string, ModelGenerationStatus> {
  const completed = new Set<string>();
  const generating = new Set<string>();
  const failed = new Set<string>();
  for (const shotId of shotIds) {
    for (const v of variantsByShot.get(shotId) ?? []) {
      if ((v.divergedAt ?? null) !== null || v.discardedAt !== null) continue;
      if (v.status === 'completed' && v.url) completed.add(v.model);
      else if (v.status === 'generating' || v.status === 'pending')
        generating.add(v.model);
      else if (v.status === 'failed') failed.add(v.model);
    }
  }
  const map = new Map<string, ModelGenerationStatus>();
  for (const m of failed) map.set(m, 'failed');
  for (const m of generating) map.set(m, 'generating');
  for (const m of completed) map.set(m, 'completed');
  map.set(setModel, 'set');
  return map;
}

type ScenesViewProps = {
  sequenceId: string;
};

const CompareWithPromptDiff: React.FC<{
  sequenceId: string;
  shot: ShotWithImage;
  variant: ShotVariant;
  onClose: () => void;
  onPromote: () => void;
  onDiscard: () => void;
  isPromoting: boolean;
  isDiscarding: boolean;
}> = ({
  sequenceId,
  shot,
  variant,
  onClose,
  onPromote,
  onDiscard,
  isPromoting,
  isDiscarding,
}) => {
  const { data: promptDiff } = useQuery({
    queryKey: ['variant-prompt-diff', sequenceId, variant.id],
    queryFn: () =>
      getDivergentVariantPromptDiffFn({
        data: { sequenceId, variantId: variant.id },
      }),
    staleTime: 30_000,
  });
  return (
    <DivergenceCompareDialog
      open={true}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      shot={shot}
      variant={variant}
      onPromote={onPromote}
      onDiscard={onDiscard}
      isPromoting={isPromoting}
      isDiscarding={isDiscarding}
      promptDiff={promptDiff ?? undefined}
    />
  );
};

// Full class names required for Tailwind JIT to detect at build time
// Split into max-width (for the wrapper, enables centering) and max-height (for the player div)
const PLAYER_MAX_W_BY_RATIO: Record<AspectRatio, string> = {
  '16:9': 'max-w-[calc(50vh*1.7777777777777777)]',
  '9:16': 'max-w-[calc(50vh*0.5625)]',
  '1:1': 'max-w-[50vh]',
};
const PLAYER_MAX_H = 'max-h-[50vh]';

type RegenerationType = 'image' | 'motion' | 'scene-variants';

function addToSet(prev: Set<string>, id: string): Set<string> {
  return new Set(prev).add(id);
}

function removeFromSet(prev: Set<string>, id: string): Set<string> {
  const next = new Set(prev);
  next.delete(id);
  return next;
}

function addAllToSet(prev: Set<string>, ids: string[]): Set<string> {
  const next = new Set(prev);
  for (const id of ids) next.add(id);
  return next;
}

function removeAllFromSet(prev: Set<string>, ids: string[]): Set<string> {
  const next = new Set(prev);
  for (const id of ids) next.delete(id);
  return next;
}

function isTerminalStatus(status: string | null): boolean {
  return status === 'completed' || status === 'failed';
}

function isInsufficientCreditsError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes('INSUFFICIENT_CREDITS') ||
      error.message.includes('Insufficient credits'))
  );
}

export const ScenesView: React.FC<ScenesViewProps> = ({ sequenceId }) => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const posthog = usePostHog();

  const [selectedShotId, setSelectedShotId] = useState<string | undefined>();
  const [selectedTab, setSelectedTab] = useState<TabValue>('scene-variants');

  const [regeneratingImages, setRegeneratingImages] = useState<Set<string>>(
    () => new Set()
  );
  const [regeneratingMotion, setRegeneratingMotion] = useState<Set<string>>(
    () => new Set()
  );
  const [regeneratingSceneVariants, setRegeneratingSceneVariants] = useState<
    Set<string>
  >(() => new Set());

  // Poll sequence while a motion batch is in flight so per-shot statuses stay
  // fresh. The refetchInterval fn reads from the query cache each tick to
  // avoid a circular dependency between sequence state and the poll condition.
  const { data: sequence } = useSequence(sequenceId, {
    refetchInterval: (query) => {
      const seq = query.state.data;
      if (!seq) return false;
      const cachedShots = queryClient.getQueryData<ShotWithImage[]>(
        shotKeys.list(sequenceId)
      );
      return cachedShots?.some((f) => f.videoStatus === 'generating')
        ? 2000
        : false;
    },
  });
  const aspectRatio = sequence?.aspectRatio || DEFAULT_ASPECT_RATIO;
  const isProcessing = sequence?.status === 'processing';
  const { data: style } = useStyle(sequence?.styleId ?? '');
  const styleCategory = style?.category ?? undefined;
  const sequenceMusicModel = safeAudioModel(
    sequence?.musicModel,
    DEFAULT_MUSIC_MODEL
  );
  const styleName = style?.name ?? undefined;
  const recommendedImageModel = style?.recommendedImageModel ?? null;
  const recommendedVideoModel = style?.recommendedVideoModel ?? null;

  // Phase config from DB — set in stone when the workflow was triggered
  const phaseConfig = useMemo<GenerationPhaseConfig>(
    () => ({
      autoGenerateMotion: sequence?.autoGenerateMotion ?? false,
      autoGenerateMusic: sequence?.autoGenerateMusic ?? false,
    }),
    [sequence?.autoGenerateMotion, sequence?.autoGenerateMusic]
  );

  // Subscribe to real-time generation events when sequence is processing.
  // Skip history replay for non-processing sequences to avoid a brief flash of
  // the progress banner on tab re-mount caused by replaying old phase events.
  const {
    state: generationState,
    status: realtimeStatus,
    reset: resetGenerationStream,
  } = useGenerationStream(sequenceId, phaseConfig, {
    replayHistory: isProcessing,
  });

  // Hybrid polling: only poll when processing AND realtime has failed
  // - 'connecting' → wait for connection, don't poll
  // - 'connected' → use realtime, don't poll
  // - 'disconnected'/'error' → poll as fallback
  const realtimeFailed = realtimeStatus === 'error';
  const shouldPoll = isProcessing && realtimeFailed;

  // Fetch shots — only poll when processing AND realtime has failed.
  // Otherwise realtime events keep the cache fresh via updateQueryCacheFromEvent.
  const { data: shots } = useShotsBySequence(
    sequenceId,
    shouldPoll ? { refetchInterval: 2000 } : undefined
  );

  // Fetch image variants for this sequence (frame_variants kind:'model', #989)
  const { data: imageVariants } = useQuery<ImageVariantWithShot[]>({
    queryKey: ['sequence-image-variants', sequenceId],
    queryFn: () => getSequenceImageVariantsFn({ data: { sequenceId } }),
    staleTime: 30_000,
    enabled: !!sequenceId,
  });

  // Video variants + viewer-local active video model (#545). When the viewer
  // pins a model in the header dropdown, the player resolves every shot's
  // video through that model's variant; "Mixed" (null) keeps each shot's own
  // (legacy) video.
  const { data: videoVariants } = useSequenceVideoVariants(sequenceId);
  const { activeVideoModel } = useActiveVideoModel(sequenceId);

  const videoVariantsByShot = useMemo(() => {
    const map = new Map<string, ShotVariant[]>();
    if (!videoVariants) return map;
    for (const v of videoVariants) {
      if (v.variantType !== 'video') continue;
      const list = map.get(v.shotId) ?? [];
      list.push(v);
      map.set(v.shotId, list);
    }
    return map;
  }, [videoVariants]);

  // Viewer-local active image model (#547). When pinned, the player shows that
  // model's image for each shot (falling back to the legacy thumbnail when the
  // model has no completed image for a shot).
  const { activeImageModel } = useActiveImageModel(sequenceId);
  // Image variants are frame_variants now; each carries its owning `shotId`
  // (frame ids ≠ shot ids, #989), so key the map by shot id. The query already
  // returns only kind:'model', non-discarded rows.
  const imageVariantsByShot = useMemo(() => {
    const map = new Map<string, FrameVariant[]>();
    if (!imageVariants) return map;
    for (const v of imageVariants) {
      const list = map.get(v.shotId) ?? [];
      list.push(v);
      map.set(v.shotId, list);
    }
    return map;
  }, [imageVariants]);

  // Scenes the pinned image model has NOT generated yet (#547). When a model is
  // pinned, the player + scene list flag these so a viewer isn't shown the
  // primary image as if it were the pinned model's output.
  const activeImageModelLabel =
    activeImageModel && isValidTextToImageModel(activeImageModel)
      ? IMAGE_MODELS[activeImageModel].name
      : null;
  const shotsMissingActiveImage = useMemo(() => {
    const missing = new Set<string>();
    if (!activeImageModel || !shots) return missing;
    for (const f of shots) {
      const hasModel = imageVariantsByShot
        .get(f.id)
        ?.some(
          (v) =>
            v.model === activeImageModel &&
            v.discardedAt === null &&
            v.status === 'completed' &&
            v.url
        );
      if (!hasModel) missing.add(f.id);
    }
    return missing;
  }, [activeImageModel, shots, imageVariantsByShot]);

  // Divergent alternates + realtime stale:detected wiring (issue #625).
  // Mirror the shots-list polling fallback so the corner-dot still updates
  // when realtime is down.
  const { data: divergentVariants } = useDivergentVariants(
    sequenceId,
    shouldPoll ? { refetchInterval: 2000 } : undefined
  );
  useStaleDetected(sequenceId);
  const promoteVariant = usePromoteVariantToPrimary();
  const discardVariant = useDiscardVariant();
  const undiscardVariant = useUndiscardVariant();
  const [compareVariant, setCompareVariant] = useState<ShotVariant | null>(
    null
  );

  const handleDiscardWithUndo = useCallback(
    (variant: ShotVariant) => {
      const restore = () => {
        undiscardVariant.mutate(
          {
            sequenceId,
            shotId: variant.shotId,
            variantId: variant.id,
          },
          {
            onError: (error) => {
              toast.error('Failed to restore alternate', {
                description:
                  error instanceof Error ? error.message : 'Unknown error',
              });
            },
          }
        );
      };
      discardVariant.mutate(
        { sequenceId, shotId: variant.shotId, variantId: variant.id },
        {
          onSuccess: () => {
            // Only close the dialog after the mutation succeeds — on failure
            // the user keeps the dialog open and can retry from there.
            setCompareVariant(null);
            toast('Alternate discarded', {
              action: { label: 'Undo', onClick: restore },
            });
          },
          onError: (error) => {
            toast.error('Failed to discard alternate', {
              description:
                error instanceof Error ? error.message : 'Unknown error',
            });
          },
        }
      );
    },
    [sequenceId, discardVariant, undiscardVariant]
  );

  // If the shot backing the open compare dialog disappears (e.g. concurrent
  // delete from another tab), close the dialog explicitly with a toast rather
  // than silently null-rendering it.
  useEffect(() => {
    if (!compareVariant || !shots) return;
    const stillExists = shots.some((f) => f.id === compareVariant.shotId);
    if (!stillExists) {
      toast.info('Scene was removed.');
      setCompareVariant(null);
    }
  }, [compareVariant, shots]);

  const handlePromote = useCallback(
    (variant: ShotVariant) => {
      promoteVariant.mutate(
        { sequenceId, shotId: variant.shotId, variantId: variant.id },
        {
          onSuccess: () => {
            setCompareVariant(null);
            toast.success('Alternate promoted');
          },
          onError: (error) => {
            toast.error('Failed to promote alternate', {
              description:
                error instanceof Error ? error.message : 'Unknown error',
            });
          },
        }
      );
    },
    [sequenceId, promoteVariant]
  );

  const curSelectedShotId = selectedShotId || shots?.[0]?.id;
  const selectedShot = useMemo(
    () => shots?.find((shot) => shot.id === curSelectedShotId),
    [shots, curSelectedShotId]
  );

  // Scenes group the shots; they carry no model of their own (#1066).
  const { data: scenes } = useScenesBySequence(sequenceId);
  const scenesById = useMemo(() => {
    const map = new Map<string, SceneRow>();
    for (const scene of scenes ?? []) map.set(scene.id, scene);
    return map;
  }, [scenes]);
  const selectedScene = selectedShot?.sceneId
    ? scenesById.get(selectedShot.sceneId)
    : undefined;

  // Model identity lives on the version that produced the asset (#1066), so the
  // tabs target whatever the selected shot's selected image/video version was
  // rendered with. A pick in the dropdown is a per-request override for the
  // NEXT generation — it becomes durable once that version is selected, so it's
  // held per-shot in view state rather than written anywhere. Pairing the pick
  // with its shot id (instead of resetting via an effect) drops it the moment
  // the selection moves to another shot.
  const { data: selectedModels } = useSequenceSelectedModels(sequenceId);
  const [imageModelPick, setImageModelPick] = useState<{
    shotId: string;
    model: TextToImageModel;
  } | null>(null);
  const [videoModelPick, setVideoModelPick] = useState<{
    shotId: string;
    model: ImageToVideoModel;
  } | null>(null);
  const resolvedImageModel = resolveImageModel({
    explicit:
      imageModelPick && imageModelPick.shotId === curSelectedShotId
        ? imageModelPick.model
        : null,
    selectedVersionModel: curSelectedShotId
      ? selectedModels?.imageModelByShot[curSelectedShotId]
      : null,
    sequenceModel: sequence?.imageModel,
  });
  const resolvedVideoModel = resolveVideoModel({
    explicit:
      videoModelPick && videoModelPick.shotId === curSelectedShotId
        ? videoModelPick.model
        : null,
    selectedVersionModel: curSelectedShotId
      ? selectedModels?.videoModelByShot[curSelectedShotId]
      : null,
    sequenceModel: sequence?.videoModel,
  });

  // Per-model coverage for the selected scene's shots — feeds the scene bar's
  // Look/Motion dropdown markers (which models have generated, and how many).
  const sceneShotIds = useMemo(() => {
    const set = new Set<string>();
    if (!selectedScene || !shots) return set;
    for (const s of shots) if (s.sceneId === selectedScene.id) set.add(s.id);
    return set;
  }, [selectedScene, shots]);
  const sceneImageModelStatuses = useMemo(
    () =>
      buildSceneModelStatuses(
        imageVariantsByShot,
        sceneShotIds,
        resolvedImageModel
      ),
    [imageVariantsByShot, sceneShotIds, resolvedImageModel]
  );
  const sceneVideoModelStatuses = useMemo(
    () =>
      buildSceneModelStatuses(
        videoVariantsByShot,
        sceneShotIds,
        resolvedVideoModel
      ),
    [videoVariantsByShot, sceneShotIds, resolvedVideoModel]
  );

  const handleImageModelChange = useCallback(
    (model: TextToImageModel) => {
      if (!curSelectedShotId) return;
      setImageModelPick({ shotId: curSelectedShotId, model });
    },
    [curSelectedShotId]
  );
  const handleVideoModelChange = useCallback(
    (model: ImageToVideoModel) => {
      if (!curSelectedShotId) return;
      setVideoModelPick({ shotId: curSelectedShotId, model });
    },
    [curSelectedShotId]
  );

  // In-flight retry state (#882) for the selected shot. Image retry matters
  // before the thumbnail exists; video retry after — the image entry is cleared
  // once it completes, so preferring it is correct in both stages.
  const selectedShotRetry = useMemo(() => {
    if (!curSelectedShotId) return undefined;
    const r = generationState.shotRetries.get(curSelectedShotId);
    return r?.image ?? r?.video;
  }, [generationState.shotRetries, curSelectedShotId]);

  // Filter variants for the currently selected shot (by owning shotId — frame
  // ids ≠ shot ids, #989).
  const selectedShotVariants = useMemo(() => {
    if (!imageVariants || !curSelectedShotId) return undefined;
    return imageVariants.filter((v) => v.shotId === curSelectedShotId);
  }, [imageVariants, curSelectedShotId]);

  // The image-prompt tab targets the shot's resolved look model (#1066); its
  // variant + Set/Generate state track that model. The header pin (#547) stays
  // a viewer-local *display* concern, handled in the player remap below.
  const effectiveImageModel = resolvedImageModel;

  const variantForSelectedModel = useMemo(() => {
    if (!selectedShotVariants) return undefined;
    return selectedShotVariants.find((v) => v.model === effectiveImageModel);
  }, [selectedShotVariants, effectiveImageModel]);

  // Motion mirror: the scene's video model drives the motion-prompt tab's
  // variant + Set/Generate state. Excludes divergent / discarded alternates so
  // only the primary per-model row is matched.
  const effectiveVideoModel = resolvedVideoModel;

  const videoVariantForSelectedModel = useMemo(() => {
    if (!curSelectedShotId) return undefined;
    return videoVariantsByShot
      .get(curSelectedShotId)
      ?.find(
        (v) =>
          v.model === effectiveVideoModel &&
          v.divergedAt === null &&
          v.discardedAt === null
      );
  }, [videoVariantsByShot, curSelectedShotId, effectiveVideoModel]);

  const { previewVariantUrl, previewVariantVideoUrl, playerBadgeMessage } =
    useMemo(() => {
      const none = {
        previewVariantUrl: null,
        previewVariantVideoUrl: null,
        playerBadgeMessage: null,
      };
      if (!selectedShot) return none;

      // Image preview (image-prompt tab)
      if (selectedTab === 'image-prompt') {
        if (
          variantForSelectedModel?.status === 'completed' &&
          variantForSelectedModel.url &&
          variantForSelectedModel.url !== selectedShot.thumbnailUrl
        ) {
          return {
            ...none,
            previewVariantUrl: variantForSelectedModel.url,
            playerBadgeMessage: 'Click Set Image to use',
          };
        }
        const shotImageModel = safeTextToImageModel(
          selectedShot.imageModel,
          DEFAULT_IMAGE_MODEL
        );
        if (
          effectiveImageModel !== shotImageModel &&
          !variantForSelectedModel
        ) {
          return {
            ...none,
            playerBadgeMessage: 'Click Generate Image to create',
          };
        }
        return none;
      }

      // Video preview (motion-prompt tab) — mirror of the image flow (#545)
      if (selectedTab === 'motion-prompt') {
        if (
          videoVariantForSelectedModel?.status === 'completed' &&
          videoVariantForSelectedModel.url &&
          videoVariantForSelectedModel.url !== selectedShot.videoUrl
        ) {
          return {
            ...none,
            previewVariantVideoUrl: videoVariantForSelectedModel.url,
            playerBadgeMessage: 'Click Set Video to use',
          };
        }
        const shotVideoModel = safeImageToVideoModel(
          selectedShot.motionModel,
          DEFAULT_VIDEO_MODEL
        );
        // Prompt when the scene's video model differs from the shot's current
        // one and no variant exists yet for it.
        if (
          effectiveVideoModel !== shotVideoModel &&
          !videoVariantForSelectedModel
        ) {
          return {
            ...none,
            playerBadgeMessage: 'Click Generate Motion to create',
          };
        }
        return none;
      }

      return none;
    }, [
      selectedTab,
      selectedShot,
      effectiveImageModel,
      variantForSelectedModel,
      effectiveVideoModel,
      videoVariantForSelectedModel,
    ]);

  // Shots as shown by the player: when an image and/or video model is pinned,
  // swap each shot's image / video for that model's variant. Only the player
  // display is remapped — every other consumer keeps the raw `shots`
  // (generation status, selection, the per-shot preview overlay, etc.).
  const playerShots = useMemo(() => {
    if (!shots) return shots;
    // Wait for the relevant variants query before remapping, so we don't blank
    // a pinned type while its data is still loading. The image pin is suppressed
    // on the image-prompt tab, where the per-shot preview overlay + prompt
    // panel govern the displayed image (avoids desyncing them from the header).
    const pinImage =
      activeImageModel && imageVariants && selectedTab !== 'image-prompt';
    const pinVideo = activeVideoModel && videoVariants;
    if (!pinImage && !pinVideo) return shots;
    return shots.map((f) => {
      let next = f;
      if (pinImage) {
        // Image: swap the displayed image; fall back to the legacy thumbnail
        // when the pinned model has no completed image for this shot (never
        // leave a shot imageless).
        const iv = imageVariantsByShot
          .get(f.id)
          ?.find(
            (v) =>
              v.model === activeImageModel &&
              v.discardedAt === null &&
              v.status === 'completed' &&
              v.url
          );
        if (iv?.url) next = { ...next, thumbnailUrl: iv.url };
      }
      if (pinVideo) {
        // Video: show only the pinned model's output (no fallback — a missing
        // variant means that model hasn't produced this shot yet).
        const vv = videoVariantsByShot
          .get(f.id)
          ?.find(
            (v) =>
              v.model === activeVideoModel &&
              v.divergedAt === null &&
              v.discardedAt === null
          );
        next = vv
          ? {
              ...next,
              videoUrl: vv.status === 'completed' ? vv.url : null,
              videoStatus: vv.status,
            }
          : { ...next, videoUrl: null, videoStatus: 'pending' as const };
      }
      return next;
    });
  }, [
    shots,
    selectedTab,
    activeImageModel,
    imageVariants,
    imageVariantsByShot,
    activeVideoModel,
    videoVariants,
    videoVariantsByShot,
  ]);

  const setterForType = useCallback((type: RegenerationType) => {
    switch (type) {
      case 'image':
        return setRegeneratingImages;
      case 'motion':
        return setRegeneratingMotion;
      case 'scene-variants':
        return setRegeneratingSceneVariants;
    }
  }, []);

  const handleRegenerateStart = useCallback(
    (shotId: string, type: RegenerationType) => {
      setterForType(type)((prev) => addToSet(prev, shotId));
    },
    [setterForType]
  );

  const handleRegenerateEnd = useCallback(
    (shotId: string, type: RegenerationType) => {
      setterForType(type)((prev) => removeFromSet(prev, shotId));
    },
    [setterForType]
  );

  // Auto-remove shots from regenerating sets when generation completes or fails
  useEffect(() => {
    if (!shots) return;

    for (const shot of shots) {
      if (
        regeneratingImages.has(shot.id) &&
        isTerminalStatus(shot.thumbnailStatus)
      )
        handleRegenerateEnd(shot.id, 'image');
      if (regeneratingMotion.has(shot.id) && isTerminalStatus(shot.videoStatus))
        handleRegenerateEnd(shot.id, 'motion');
      if (
        regeneratingSceneVariants.has(shot.id) &&
        isTerminalStatus(shot.variantImageStatus)
      )
        handleRegenerateEnd(shot.id, 'scene-variants');
    }
  }, [
    shots,
    regeneratingImages,
    regeneratingMotion,
    regeneratingSceneVariants,
    handleRegenerateEnd,
  ]);

  // Derive motion banner state from query data so it persists naturally across
  // tab switches — no local state needed. startedAt uses the earliest
  // generating shot's updatedAt so elapsed time stays accurate.
  const motionBannerState = useMemo(() => {
    if (!shots || !sequence) return null;
    const anyGenerating = shots.some((f) => f.videoStatus === 'generating');
    if (!anyGenerating) return null;
    const generatingTimes = shots
      .filter((f) => f.videoStatus === 'generating')
      .map((f) => f.updatedAt.getTime());
    const startedAt =
      generatingTimes.length > 0 ? Math.min(...generatingTimes) : Date.now();
    return {
      startedAt,
      includeMusic: sequence.musicStatus === 'generating',
    };
  }, [shots, sequence]);

  const [isRetrying, setIsRetrying] = useState(false);

  const failureSummary = useMemo(
    () => (sequence ? analyzeFailures(shots ?? [], sequence) : null),
    [shots, sequence]
  );

  const handleFullRetry = useCallback(() => {
    void navigate({ to: '/sequences/$id/script', params: { id: sequenceId } });
  }, [sequenceId, navigate]);

  const handleSmartRetry = useCallback(async () => {
    setIsRetrying(true);
    try {
      const result = await smartRetryFn({ data: { sequenceId } });
      toast.success(`Retrying: ${result.retriedItems.join(', ')}`);
      void queryClient.invalidateQueries({
        queryKey: ['sequence', sequenceId],
      });
      void queryClient.invalidateQueries({ queryKey: ['shots', sequenceId] });
    } catch (error) {
      if (isInsufficientCreditsError(error)) {
        toast.error('Insufficient credits', {
          description: 'Add credits to retry.',
          action: {
            label: 'Add Credits',
            onClick: () => {
              window.location.href = '/credits';
            },
          },
        });
        void queryClient.invalidateQueries({
          queryKey: BILLING_BALANCE_KEY,
        });
      } else {
        toast.error('Failed to retry', {
          description: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    } finally {
      setIsRetrying(false);
    }
  }, [sequenceId, queryClient]);

  // Handler for batch motion generation (server determines eligible shots)
  const handleBatchMotionGeneration = useCallback(
    async ({
      includeMusic,
      musicModel,
      generateAudio,
    }: BatchGenerateMotionArgs) => {
      // Optimistic: compute eligible shots locally (same filter as backend)
      const eligibleShotIds = (shots ?? [])
        .filter(
          (f) =>
            f.thumbnailStatus === 'completed' &&
            (f.videoStatus === 'pending' || f.videoStatus === 'failed')
        )
        .map((f) => f.id);

      setRegeneratingMotion((prev) => addAllToSet(prev, eligibleShotIds));

      // Optimistically mark shots as generating in the query cache so the
      // derived banner state shows the banner immediately — no separate state.
      const eligibleSet = new Set(eligibleShotIds);
      const now = new Date();
      queryClient.setQueryData<ShotWithImage[]>(
        shotKeys.list(sequenceId),
        (old) =>
          old?.map((f) =>
            eligibleSet.has(f.id)
              ? { ...f, videoStatus: 'generating', updatedAt: now }
              : f
          )
      );
      if (includeMusic) {
        queryClient.setQueryData<Sequence>(
          sequenceKeys.detail(sequenceId),
          (old) => (old ? { ...old, musicStatus: 'generating' } : old)
        );
      }

      posthog.capture('motion_generation_started', {
        sequence_id: sequenceId,
        include_music: includeMusic,
        eligible_shot_count: eligibleShotIds.length,
        // Motion model is resolved per shot server-side, from each shot's
        // selected video version (#1066).
        music_model: includeMusic ? musicModel : undefined,
        generate_audio: generateAudio,
      });

      try {
        await batchGenerateMotionFn({
          data: {
            sequenceId,
            includeMusic,
            musicModel: includeMusic ? musicModel : undefined,
            generateAudio,
          },
        });
        // Server may have updated sequence.videoModel / sequence.musicModel to
        // the batch picks; invalidate so the header badge, footer pre-fill,
        // and per-shot fallback all reflect the new values.
        void queryClient.invalidateQueries({
          queryKey: sequenceKeys.detail(sequenceId),
        });
      } catch (error) {
        setRegeneratingMotion((prev) =>
          removeAllFromSet(prev, eligibleShotIds)
        );
        // Roll back optimistic cache updates
        queryClient.setQueryData<ShotWithImage[]>(
          shotKeys.list(sequenceId),
          (old) =>
            old?.map((f) =>
              eligibleSet.has(f.id) ? { ...f, videoStatus: 'pending' } : f
            )
        );
        if (includeMusic) {
          void queryClient.invalidateQueries({
            queryKey: sequenceKeys.detail(sequenceId),
          });
        }

        if (isInsufficientCreditsError(error)) {
          toast.error('Insufficient credits', {
            description: 'Add credits to generate motion for all shots.',
            action: {
              label: 'Add Credits',
              onClick: () => {
                window.location.href = '/credits';
              },
            },
          });
          void queryClient.invalidateQueries({
            queryKey: BILLING_BALANCE_KEY,
          });
        } else {
          throw error;
        }
      }
    },
    [sequenceId, shots, queryClient, posthog]
  );

  const musicPromptsReady = !!(sequence?.musicPrompt && sequence.musicTags);

  // GenerationProgressBanner is owned by the script-analysis pipeline
  // (sequence.status === 'processing'). Standalone motion gen runs when the
  // sequence is already 'completed' / 'ready', so it must render via the
  // dedicated MotionProgressBanner — never the 5-stage banner. Trusting
  // generationState.currentPhase here would let leftover phase events from
  // past runs hijack the UI back to the 5-stage banner.
  const isGenerationActive = isProcessing;

  return (
    <div className="flex h-full flex-col">
      {/* Generation progress banner */}
      {isGenerationActive && (
        <div className="pl-4 pr-4 pt-4 md:pr-8">
          <GenerationProgressBanner
            generationState={generationState}
            isProcessing={isProcessing}
            startedAt={sequence.updatedAt}
            script={sequence.script ?? undefined}
          />
        </div>
      )}

      {/* Motion generation progress banner */}
      {!isGenerationActive &&
        motionBannerState !== null &&
        sequence &&
        shots && (
          <div className="pl-4 pr-4 pt-4 md:pr-8">
            <MotionProgressBanner
              shots={shots}
              sequence={sequence}
              includeMusic={motionBannerState.includeMusic}
              startedAt={motionBannerState.startedAt}
              onComplete={resetGenerationStream}
            />
          </div>
        )}

      {/* Failure summary with smart retry */}
      {failureSummary?.hasFailed && (
        <FailureSummaryBanner
          summary={failureSummary}
          onRetry={() => void handleSmartRetry()}
          onFullRetry={handleFullRetry}
          isRetrying={isRetrying}
        />
      )}

      <div className="flex flex-1 min-h-0">
        {/* Desktop: Scene List sidebar */}
        <div className="hidden md:block pl-4 py-4">
          <SceneList
            shots={shots}
            selectedShotId={curSelectedShotId}
            aspectRatio={aspectRatio}
            onSelectShot={setSelectedShotId}
            regeneratingImages={regeneratingImages}
            regeneratingMotion={regeneratingMotion}
            onBatchGenerateMotion={handleBatchMotionGeneration}
            musicPromptsReady={musicPromptsReady}
            hideBatchButton={
              phaseConfig.autoGenerateMotion && isGenerationActive
            }
            divergentVariants={divergentVariants}
            onCompareDivergent={(variant) => setCompareVariant(variant)}
            initialMusicModel={sequenceMusicModel}
            modelMissingShotIds={shotsMissingActiveImage}
            modelMissingLabel={activeImageModelLabel}
          />
        </div>

        {/* Mobile: Bottom drawer */}
        <div className="md:hidden">
          <MobileSceneDrawer
            shots={shots}
            selectedShotId={curSelectedShotId}
            aspectRatio={aspectRatio}
            onSelectShot={setSelectedShotId}
            regeneratingImages={regeneratingImages}
            regeneratingMotion={regeneratingMotion}
            onBatchGenerateMotion={handleBatchMotionGeneration}
            musicPromptsReady={musicPromptsReady}
            hideBatchButton={
              phaseConfig.autoGenerateMotion && isGenerationActive
            }
            initialMusicModel={sequenceMusicModel}
          />
        </div>

        {/* Main content area */}
        <ScrollArea className="flex-1 px-4 md:px-8 gap-8 flex flex-col pb-20 md:pb-0 pt-4">
          <div className="flex flex-1 min-h-0 justify-center pb-8">
            <ScenePlayer
              shots={playerShots}
              selectedShotId={curSelectedShotId}
              aspectRatio={aspectRatio}
              onSelectShot={setSelectedShotId}
              selectedTab={selectedTab}
              overrideImageUrl={previewVariantUrl}
              overrideVideoUrl={previewVariantVideoUrl}
              badgeMessage={playerBadgeMessage}
              modelMismatchLabel={
                selectedTab === 'scene-variants' &&
                activeImageModelLabel &&
                curSelectedShotId &&
                shotsMissingActiveImage.has(curSelectedShotId)
                  ? `Not generated with ${activeImageModelLabel}`
                  : null
              }
              progressMessage={
                generationState.phases.find((p) => p.status === 'active')
                  ?.phaseName
              }
              retry={selectedShotRetry}
              posterUrl={sequence?.posterUrl ?? undefined}
              className={PLAYER_MAX_H}
              wrapperClassName={PLAYER_MAX_W_BY_RATIO[aspectRatio]}
            />
          </div>
          <SceneScriptPrompts
            shot={selectedShot}
            sequenceId={sequenceId}
            selectedTab={selectedTab}
            onTabChange={setSelectedTab}
            regeneratingImages={regeneratingImages}
            regeneratingMotion={regeneratingMotion}
            regeneratingSceneVariants={regeneratingSceneVariants}
            onRegenerateStart={handleRegenerateStart}
            aspectRatio={aspectRatio}
            variantForSelectedModel={variantForSelectedModel}
            videoVariantForSelectedModel={videoVariantForSelectedModel}
            resolvedImageModel={resolvedImageModel}
            resolvedVideoModel={resolvedVideoModel}
            imageModelStatuses={sceneImageModelStatuses}
            videoModelStatuses={sceneVideoModelStatuses}
            onImageModelChange={handleImageModelChange}
            onVideoModelChange={handleVideoModelChange}
            styleCategory={styleCategory}
            styleName={styleName}
            recommendedImageModel={recommendedImageModel}
            recommendedVideoModel={recommendedVideoModel}
            shotDivergentVariants={divergentVariants?.filter(
              (v) => v.shotId === curSelectedShotId
            )}
            onCompareDivergent={(variant) => setCompareVariant(variant)}
          />
        </ScrollArea>
      </div>

      {compareVariant &&
        (() => {
          const targetShot = shots?.find((f) => f.id === compareVariant.shotId);
          if (!targetShot) return null;
          return (
            <CompareWithPromptDiff
              sequenceId={sequenceId}
              shot={targetShot}
              variant={compareVariant}
              onClose={() => setCompareVariant(null)}
              onPromote={() => handlePromote(compareVariant)}
              onDiscard={() => handleDiscardWithUndo(compareVariant)}
              isPromoting={promoteVariant.isPending}
              isDiscarding={discardVariant.isPending}
            />
          );
        })()}
    </div>
  );
};
