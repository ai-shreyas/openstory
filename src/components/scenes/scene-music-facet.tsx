import { MusicView, MusicViewSkeleton } from '@/components/music/music-view';
import { DivergentAlternateBanner } from '@/components/staleness/divergent-alternate-banner';
import {
  getMusicPromptStalenessFn,
  regenerateMusicPromptFn,
} from '@/functions/prompt-variants';
import { generateMusicFn } from '@/functions/sequences';
import { useActiveAudioModel } from '@/hooks/use-active-audio-model';
import { useShotsBySequence } from '@/hooks/use-shots';
import {
  musicPromptStalenessKey,
  sequenceKeys,
  useSequence,
  useSequenceAudioVariants,
  useSetSequenceMusic,
} from '@/hooks/use-sequences';
import {
  useDiscardSequenceMusicVariant,
  usePromoteSequenceMusicVariant,
  useSequenceDivergentMusicVariants,
  useSetMusicFromVariant,
  useUndiscardSequenceMusicVariant,
} from '@/hooks/use-sequence-variants';
import { type ModelGenerationStatus } from '@/components/model/base-model-selector';
import {
  DEFAULT_MUSIC_MODEL,
  safeAudioModel,
  type AudioModel,
} from '@/lib/ai/models';
import type { SequenceMusicVariant } from '@/lib/db/schema';
import { useGenerationStream } from '@/lib/realtime/use-generation-stream';
import { useSequenceStaleDetected } from '@/lib/realtime/use-sequence-stale-detected';
import type { Sequence } from '@/types/database';
import { Music } from 'lucide-react';
import { usePostHog } from '@posthog/react';
import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

type SceneMusicFacetProps = {
  sequenceId: string;
  /** Music is editable only at sequence scope (#986). */
  editable: boolean;
};

export const SceneMusicFacet: React.FC<SceneMusicFacetProps> = ({
  sequenceId,
  editable,
}) => {
  const { data: sequence, isLoading } = useSequence(sequenceId);
  const { data: shots } = useShotsBySequence(sequenceId, {
    refetchInterval: false,
  });
  const { activeAudioModel, selectAudioModel } =
    useActiveAudioModel(sequenceId);
  const { data: audioVariants } = useSequenceAudioVariants(sequenceId);

  const resolvedSequence = useMemo<Sequence | undefined>(() => {
    if (!sequence || !activeAudioModel || !audioVariants) return sequence;
    if (sequence.musicStatus !== 'completed') return sequence;
    const variant = audioVariants.find(
      (v) =>
        v.model === activeAudioModel &&
        v.divergedAt === null &&
        v.discardedAt === null &&
        v.status === 'completed' &&
        v.url
    );
    if (!variant?.url) return sequence;
    return { ...sequence, musicUrl: variant.url };
  }, [sequence, activeAudioModel, audioVariants]);

  const audioModelStatuses = useMemo(() => {
    const map = new Map<string, ModelGenerationStatus>();
    const variants = (audioVariants ?? []).filter(
      (v) => v.divergedAt === null && v.discardedAt === null
    );
    const primaryUrl = sequence?.musicUrl ?? null;
    const setModel = primaryUrl
      ? (variants.find((v) => v.url === primaryUrl)?.model ??
        sequence?.musicModel ??
        null)
      : null;
    for (const v of variants) {
      map.set(v.model, v.model === setModel ? 'set' : v.status);
    }
    if (setModel && !map.has(setModel)) map.set(setModel, 'set');
    if (sequence?.musicStatus === 'generating' && sequence.musicModel) {
      map.set(sequence.musicModel, 'generating');
    }
    return map;
  }, [
    audioVariants,
    sequence?.musicUrl,
    sequence?.musicModel,
    sequence?.musicStatus,
  ]);

  const queryClient = useQueryClient();
  const posthog = usePostHog();
  useGenerationStream(sequenceId);
  useSequenceStaleDetected(sequenceId);

  const videoDuration = useMemo(() => {
    if (!shots?.length) return undefined;
    return shots.reduce(
      (sum, shot) => sum + (shot.durationMs ? shot.durationMs / 1000 : 10),
      0
    );
  }, [shots]);

  const generating = sequence?.musicStatus === 'generating';
  const { data: divergentMusicVariants } = useSequenceDivergentMusicVariants(
    sequenceId,
    generating ? { refetchInterval: 2000 } : undefined
  );

  const setMusicEnabled = useSetSequenceMusic(sequenceId);
  const promoteVariant = usePromoteSequenceMusicVariant();
  const discardVariant = useDiscardSequenceMusicVariant();
  const undiscardVariant = useUndiscardSequenceMusicVariant();
  const setMusicModel = useSetMusicFromVariant();

  const handleDiscardWithUndo = useCallback(
    (variant: SequenceMusicVariant) => {
      const restore = () => {
        undiscardVariant.mutate(
          { sequenceId, variantId: variant.id },
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
        { sequenceId, variantId: variant.id },
        {
          onSuccess: () => {
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

  const handlePromote = useCallback(
    (variant: SequenceMusicVariant) => {
      promoteVariant.mutate(
        { sequenceId, variantId: variant.id },
        {
          onSuccess: () => toast.success('Alternate promoted'),
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

  const handleSetModel = useCallback(
    (model: AudioModel) => {
      setMusicModel.mutate(
        { sequenceId, model },
        {
          onSuccess: () => toast.success('Music model set'),
          onError: (error) => {
            toast.error('Failed to set music model', {
              description:
                error instanceof Error ? error.message : 'Unknown error',
            });
          },
        }
      );
    },
    [sequenceId, setMusicModel]
  );

  const generateMusic = useMutation({
    mutationFn: (args?: {
      prompt?: string;
      tags?: string;
      model?: string;
      duration?: number;
    }) =>
      generateMusicFn({
        data: {
          sequenceId,
          prompt: args?.prompt,
          tags: args?.tags,
          model: args?.model,
          duration: args?.duration,
        },
      }),
    onMutate: (args) => {
      const previous = queryClient.getQueryData<Sequence>(
        sequenceKeys.detail(sequenceId)
      );
      queryClient.setQueryData<Sequence>(
        sequenceKeys.detail(sequenceId),
        (old) => (old ? { ...old, musicStatus: 'generating' as const } : old)
      );
      posthog.capture('music_generation_started', {
        sequence_id: sequenceId,
        has_custom_prompt: !!args?.prompt,
        duration: args?.duration,
      });
      return { previous };
    },
    onError: (error, _args, context) => {
      // Roll back the optimistic 'generating' status — without this a failed
      // trigger leaves the UI on "Generating…" forever (no DB row ever flips).
      if (context?.previous) {
        queryClient.setQueryData(
          sequenceKeys.detail(sequenceId),
          context.previous
        );
      }
      toast.error('Music generation failed', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    },
  });

  const stalenessKey = musicPromptStalenessKey(sequenceId);
  const { data: musicPromptStaleness } = useQuery({
    queryKey: stalenessKey,
    queryFn: () => getMusicPromptStalenessFn({ data: { sequenceId } }),
    staleTime: 30_000,
    enabled: editable,
  });

  const regenerateMusicPrompt = useMutation({
    mutationFn: () => regenerateMusicPromptFn({ data: { sequenceId } }),
    onSuccess: async (result) => {
      if (result.alreadyUpToDate) {
        toast.info('Music prompt is already up to date');
      }
      await queryClient.invalidateQueries({
        queryKey: stalenessKey,
      });
      await queryClient.invalidateQueries({
        queryKey: sequenceKeys.detail(sequenceId),
      });
    },
    onError: (error) => {
      toast.error('Music prompt regenerate failed', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    },
  });

  if (isLoading || !sequence) {
    return <MusicViewSkeleton />;
  }

  if (!editable) {
    return (
      <div className="space-y-4 py-4">
        <div className="flex flex-col items-center text-center">
          <div className="mb-3 rounded-full bg-muted p-3">
            <Music className="h-6 w-6 text-muted-foreground/60" />
          </div>
          <p className="text-sm text-muted-foreground">
            Music is edited at sequence scope.
          </p>
          <p className="mt-1 text-xs text-muted-foreground/70">
            Clear your selection to edit the sequence track.
          </p>
        </div>
        {sequence.musicUrl && (
          <audio
            src={sequence.musicUrl}
            controls
            className="w-full"
            aria-label="Sequence music preview"
          >
            <track kind="captions" />
          </audio>
        )}
      </div>
    );
  }

  const latestDivergent = divergentMusicVariants?.[0];
  const divergentBanner = latestDivergent ? (
    <DivergentAlternateBanner
      variantId={latestDivergent.id}
      artifact="music"
      entityType="sequence"
      onPromote={() => handlePromote(latestDivergent)}
      onDiscard={() => handleDiscardWithUndo(latestDivergent)}
    />
  ) : null;

  return (
    <MusicView
      sequence={resolvedSequence ?? sequence}
      videoDuration={videoDuration}
      onGenerateMusic={(args) => generateMusic.mutate(args)}
      isGeneratingMusic={generating || generateMusic.isPending}
      audioModelStatuses={audioModelStatuses}
      selectedModel={safeAudioModel(
        activeAudioModel ?? sequence.musicModel,
        DEFAULT_MUSIC_MODEL
      )}
      onModelChange={selectAudioModel}
      onSetModel={handleSetModel}
      isSettingModel={setMusicModel.isPending}
      divergentBanner={divergentBanner}
      isMusicPromptStale={musicPromptStaleness?.musicPrompt === 'stale'}
      onRegenerateMusicPrompt={() => regenerateMusicPrompt.mutate()}
      isRegeneratingMusicPrompt={regenerateMusicPrompt.isPending}
      onIncludeMusicChange={(includeMusic) =>
        setMusicEnabled.mutate(includeMusic)
      }
    />
  );
};
