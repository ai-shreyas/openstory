import { useAuthGate } from '@/components/auth/auth-gate-provider';
import { ActionCost } from '@/components/billing/action-cost';
import { ImageModelSelector } from '@/components/model/image-model-selector';
import { MotionModelSelector } from '@/components/model/motion-model-selector';
import { AspectRatioPills } from '@/components/settings/aspect-ratio-pills';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useFalBillingGate } from '@/hooks/use-billing-gate';
import { useFalPricing } from '@/hooks/use-fal-pricing';
import { useCreateStudioAssets } from '@/hooks/use-studio-assets';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  getCompatibleModel,
  videoModelSupportsAudio,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import {
  estimateImageCost,
  estimateVideoCost,
  gateEstimate,
} from '@/lib/billing/cost-estimation';
import { addMicros, multiplyMicros } from '@/lib/billing/money';
import {
  DEFAULT_ASPECT_RATIO,
  type AspectRatio,
} from '@/lib/constants/aspect-ratios';
import { isInsufficientCreditsError } from '@/lib/errors';
import { snapDuration } from '@/lib/motion/snap-duration';
import {
  pickShufflePrompt,
  studioShufflePrompts,
} from '@/lib/studio/prompt-shuffle';
import type { StudioCreateInput } from '@/lib/studio/schema';
import { Loader2, Shuffle } from 'lucide-react';
import { useMemo, useState } from 'react';

const COUNTS = [1, 2, 4] as const;
const DURATIONS = [5, 8, 10] as const;

type StudioComposerProps = {
  activity: 'image' | 'video';
};

export function StudioComposer({ activity }: StudioComposerProps) {
  const { requireAuth } = useAuthGate();
  const { showGate } = useFalBillingGate();
  const { pricing } = useFalPricing();
  const create = useCreateStudioAssets();

  const [prompt, setPrompt] = useState('');
  const [imageModel, setImageModel] =
    useState<TextToImageModel>(DEFAULT_IMAGE_MODEL);
  const [videoModel, setVideoModel] =
    useState<ImageToVideoModel>(DEFAULT_VIDEO_MODEL);
  const [aspectRatio, setAspectRatio] =
    useState<AspectRatio>(DEFAULT_ASPECT_RATIO);
  const [count, setCount] = useState<(typeof COUNTS)[number]>(1);
  const [duration, setDuration] = useState(5);
  const [generateAudio, setGenerateAudio] = useState(true);
  const [lastShuffled, setLastShuffled] = useState<string | null>(null);
  const [replaceConfirm, setReplaceConfirm] = useState(false);

  const compatibleVideoModel = getCompatibleModel(videoModel, aspectRatio);
  const snappedDuration = snapDuration(duration, compatibleVideoModel);
  const audioCapable = videoModelSupportsAudio(compatibleVideoModel);

  const estimate = useMemo(() => {
    if (!pricing) return null;
    const still = estimateImageCost(imageModel, aspectRatio, 1, { pricing });
    if (activity === 'image') {
      const gated = gateEstimate(still, {
        model: imageModel,
        operation: 'studio-image',
      });
      return multiplyMicros(gated, count);
    }
    const motion = estimateVideoCost(compatibleVideoModel, snappedDuration, {
      pricing,
    });
    const gatedStill = gateEstimate(still, {
      model: imageModel,
      operation: 'studio-image',
    });
    const gatedMotion = gateEstimate(motion, {
      model: compatibleVideoModel,
      operation: 'studio-video',
    });
    return multiplyMicros(addMicros(gatedStill, gatedMotion), count);
  }, [
    activity,
    aspectRatio,
    compatibleVideoModel,
    count,
    imageModel,
    pricing,
    snappedDuration,
  ]);

  const trimmed = prompt.trim();
  const canSubmit = trimmed.length > 0 && !create.isPending;

  const applyShuffle = () => {
    const next = pickShufflePrompt(
      studioShufflePrompts(activity),
      prompt,
      Math.random
    );
    if (!next) return;
    setPrompt(next);
    setLastShuffled(next);
  };

  const requestShuffle = () => {
    if (trimmed.length > 0 && trimmed !== lastShuffled) {
      setReplaceConfirm(true);
      return;
    }
    applyShuffle();
  };

  const buildInput = (): StudioCreateInput => {
    if (activity === 'video') {
      return {
        activity: 'video',
        prompt: trimmed,
        imageModel,
        videoModel: compatibleVideoModel,
        aspectRatio,
        duration: snappedDuration,
        count,
        generateAudio: audioCapable ? generateAudio : undefined,
      };
    }
    return {
      activity: 'image',
      prompt: trimmed,
      imageModel,
      aspectRatio,
      count,
    };
  };

  const submit = () => {
    if (!canSubmit) return;
    requireAuth(() => {
      create.mutate(buildInput(), {
        onSuccess: () => setPrompt(''),
        onError: (error) => {
          if (isInsufficientCreditsError(error)) showGate();
        },
      });
    });
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          {activity === 'video'
            ? 'A still from your prompt, then the same models as sequences animate it.'
            : 'A still from your prompt, using the same image models as sequences.'}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          disabled={create.isPending}
          onClick={requestShuffle}
        >
          <Shuffle className="size-3.5" />
          Shuffle
        </Button>
      </div>

      <Textarea
        name="prompt"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            submit();
          }
        }}
        placeholder={
          activity === 'video'
            ? 'A red fox turns toward camera in morning fog…'
            : 'A red fox in fog at dawn, cinematic lighting…'
        }
        required
        aria-label="Prompt"
        className="min-h-24 text-base"
      />

      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-wrap items-end gap-3">
          <ImageModelSelector
            selectedModel={imageModel}
            onModelChange={setImageModel}
            disabled={create.isPending}
          />
          {activity === 'video' && (
            <MotionModelSelector
              selectedModel={compatibleVideoModel}
              onModelChange={setVideoModel}
              aspectRatio={aspectRatio}
              disabled={create.isPending}
            />
          )}
          <AspectRatioPills value={aspectRatio} onChange={setAspectRatio} />
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Count</span>
            <ToggleGroup
              type="single"
              value={String(count)}
              onValueChange={(value) => {
                const next = Number(value);
                if (next === 1 || next === 2 || next === 4) setCount(next);
              }}
              variant="outline"
              spacing={0}
              aria-label="How many to generate"
            >
              {COUNTS.map((value) => (
                <ToggleGroupItem
                  key={value}
                  value={String(value)}
                  className="px-3 font-mono text-xs"
                >
                  {value}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          {activity === 'video' && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Seconds</span>
              <ToggleGroup
                type="single"
                value={String(snappedDuration)}
                onValueChange={(value) => {
                  const next = Number(value);
                  if (Number.isFinite(next) && next > 0) {
                    setDuration(next);
                  }
                }}
                variant="outline"
                spacing={0}
                aria-label="Clip duration"
              >
                {[
                  ...new Set(
                    DURATIONS.map((value) =>
                      snapDuration(value, compatibleVideoModel)
                    )
                  ),
                ].map((value) => (
                  <ToggleGroupItem
                    key={value}
                    value={String(value)}
                    className="px-3 font-mono text-xs"
                  >
                    {value}s
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          )}
          {activity === 'video' && audioCapable && (
            <div className="flex h-9 items-center gap-2 text-sm">
              <Switch
                id="studio-generate-audio"
                checked={generateAudio}
                onCheckedChange={setGenerateAudio}
                disabled={create.isPending}
              />
              <label htmlFor="studio-generate-audio">Audio</label>
            </div>
          )}
        </div>

        <div className="flex flex-col items-stretch gap-1 sm:items-end">
          <Button type="submit" size="lg" disabled={!canSubmit}>
            {create.isPending ? (
              <>
                <Loader2 className="animate-spin" />
                Generating…
              </>
            ) : activity === 'video' ? (
              count > 1 ? (
                `Generate ${count} videos`
              ) : (
                'Generate video'
              )
            ) : count > 1 ? (
              `Generate ${count} images`
            ) : (
              'Generate image'
            )}
          </Button>
          <ActionCost estimate={estimate} align="end" />
        </div>
      </div>

      <AlertDialog open={replaceConfirm} onOpenChange={setReplaceConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace your prompt?</AlertDialogTitle>
            <AlertDialogDescription>
              Shuffle swaps in a sample prompt. What you've written here will be
              replaced.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep my prompt</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setReplaceConfirm(false);
                applyShuffle();
              }}
            >
              <Shuffle className="size-3.5" />
              Replace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}
