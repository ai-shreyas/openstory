import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import type { ShotWithImage } from '@/lib/shots/shot-with-image';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import { stripMarkdown } from '@/lib/utils/markdown-plain';
import { AppImage } from '@/components/ui/app-image';
import type React from 'react';
import { EvalCellDialog, type DialogTab } from './eval-cell-dialog';
import type { ViewMode } from './eval-view';

/**
 * Get visual prompt from shot - client-safe utility
 * Prioritizes user-updated prompt over AI-generated prompt
 */
export function getVisualPrompt(shot: ShotWithImage): string | null {
  // The visual prompt is the anchor frame's `imagePrompt` mirror (#989/#713).
  return shot.imagePrompt || null;
}

/**
 * Get motion prompt from shot - client-safe utility.
 * `shot.motionPrompt` mirrors the selected motion version; fall back to the
 * projected structured prompt's `fullPrompt` (#713).
 */
export function getMotionPrompt(shot: ShotWithImage): string | null {
  return shot.motionPrompt || shot.motionPromptData?.fullPrompt || null;
}

/**
 * Get original script extract from shot
 */
export function getSceneScript(shot: ShotWithImage): string | null {
  const scene = shot.metadata;
  return scene?.originalScript.extract || null;
}

type EvalSceneCellProps = {
  shot: ShotWithImage | undefined;
  viewMode: ViewMode;
  sceneNumber: number;
  sequenceTitle: string;
  aspectRatio: AspectRatio;
  shotsLoading?: boolean;
  dialogOpen: boolean;
  dialogInitialTab?: DialogTab;
  onDialogOpenChange: (open: boolean) => void;
  onNavigateLeft?: () => void;
  onNavigateRight?: () => void;
  onNavigateUp?: () => void;
  onNavigateDown?: () => void;
};

export const EvalSceneCell: React.FC<EvalSceneCellProps> = ({
  shot,
  viewMode,
  sceneNumber,
  sequenceTitle,
  aspectRatio,
  shotsLoading = false,
  dialogOpen,
  dialogInitialTab,
  onDialogOpenChange,
  onNavigateLeft,
  onNavigateRight,
  onNavigateUp,
  onNavigateDown,
}) => {
  const initialTab: DialogTab = dialogInitialTab ?? viewMode;
  // Empty cell for missing shots — show skeleton while shots are still
  // loading, otherwise show the "No scene N" placeholder.
  if (!shot) {
    if (shotsLoading) {
      return (
        <div className="border-b p-2 h-full">
          <Skeleton className="w-full h-full" />
        </div>
      );
    }
    return (
      <div className="border-b p-2 flex items-center justify-center h-full">
        <div className="w-full h-full border-2 border-dashed border-muted rounded-md flex items-center justify-center text-xs text-muted-foreground">
          No scene {sceneNumber}
        </div>
      </div>
    );
  }

  const prompt = getVisualPrompt(shot);
  const motionPrompt = getMotionPrompt(shot);
  const script = getSceneScript(shot);

  const handleClick = () => onDialogOpenChange(true);

  // Images view
  if (viewMode === 'images') {
    if (!shot.thumbnailUrl) {
      return (
        <div className="border-b p-2 h-full flex items-center justify-center">
          {shot.thumbnailStatus === 'generating' ? (
            <Skeleton className="w-full h-full" />
          ) : (
            <div className="text-xs text-muted-foreground text-center">
              No image
            </div>
          )}
        </div>
      );
    }

    return (
      <>
        <button
          type="button"
          className="border-b p-2 cursor-pointer hover:bg-muted/50 transition-colors h-full flex flex-col min-h-0 overflow-hidden w-full text-left appearance-none bg-transparent"
          onClick={handleClick}
        >
          <div className="flex-1 flex items-center justify-center min-h-0">
            <AppImage
              src={shot.thumbnailUrl}
              alt={`Scene ${sceneNumber}`}
              className="max-w-full max-h-full object-contain rounded-md"
              loading="lazy"
              width={400}
              height={400}
            />
          </div>
        </button>
        <EvalCellDialog
          open={dialogOpen}
          onOpenChange={onDialogOpenChange}
          shot={shot}
          sceneNumber={sceneNumber}
          sequenceTitle={sequenceTitle}
          aspectRatio={aspectRatio}
          initialTab={initialTab}
          onNavigateLeft={onNavigateLeft}
          onNavigateRight={onNavigateRight}
          onNavigateUp={onNavigateUp}
          onNavigateDown={onNavigateDown}
        />
      </>
    );
  }

  // Script view
  if (viewMode === 'script') {
    if (!script) {
      return (
        <div className="border-b p-2 h-full flex items-center justify-center">
          <div className="text-xs text-muted-foreground">No script</div>
        </div>
      );
    }

    return (
      <>
        <button
          type="button"
          className="border-b p-2 cursor-pointer hover:bg-muted/50 transition-colors h-full flex flex-col min-h-0 overflow-hidden w-full text-left appearance-none bg-transparent"
          onClick={handleClick}
        >
          <ScrollArea className="flex-1 w-full min-h-0">
            <p className="text-xs leading-relaxed whitespace-pre-wrap pr-2">
              {stripMarkdown(script)}
            </p>
          </ScrollArea>
        </button>
        <EvalCellDialog
          open={dialogOpen}
          onOpenChange={onDialogOpenChange}
          shot={shot}
          sceneNumber={sceneNumber}
          sequenceTitle={sequenceTitle}
          aspectRatio={aspectRatio}
          initialTab={initialTab}
          onNavigateLeft={onNavigateLeft}
          onNavigateRight={onNavigateRight}
          onNavigateUp={onNavigateUp}
          onNavigateDown={onNavigateDown}
        />
      </>
    );
  }

  // Motion view (individual shot videos)
  if (viewMode === 'motion') {
    if (!shot.videoUrl) {
      const isGenerating = shot.videoStatus === 'generating';

      if (shot.thumbnailUrl) {
        return (
          <>
            <button
              type="button"
              className="border-b p-2 cursor-pointer hover:bg-muted/50 transition-colors h-full flex flex-col min-h-0 overflow-hidden w-full text-left appearance-none bg-transparent"
              onClick={handleClick}
            >
              <div className="relative flex-1 flex items-center justify-center min-h-0">
                <AppImage
                  src={shot.thumbnailUrl}
                  alt={`Scene ${sceneNumber} preview`}
                  className="max-w-full max-h-full object-contain rounded-md opacity-60"
                  loading="lazy"
                  width={400}
                  height={400}
                />
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <span className="text-xs font-medium text-foreground bg-background/80 backdrop-blur-sm px-2 py-1 rounded-md border">
                    {isGenerating ? 'Generating video…' : 'No video yet'}
                  </span>
                </div>
              </div>
            </button>
            <EvalCellDialog
              open={dialogOpen}
              onOpenChange={onDialogOpenChange}
              shot={shot}
              sceneNumber={sceneNumber}
              sequenceTitle={sequenceTitle}
              aspectRatio={aspectRatio}
              initialTab={initialTab}
              onNavigateLeft={onNavigateLeft}
              onNavigateRight={onNavigateRight}
              onNavigateUp={onNavigateUp}
              onNavigateDown={onNavigateDown}
            />
          </>
        );
      }

      return (
        <div className="border-b p-2 h-full flex items-center justify-center">
          {isGenerating ? (
            <Skeleton className="w-full h-full" />
          ) : (
            <div className="text-xs text-muted-foreground text-center">
              No video
            </div>
          )}
        </div>
      );
    }

    return (
      <>
        <button
          type="button"
          className="border-b p-2 cursor-pointer hover:bg-muted/50 transition-colors h-full flex flex-col min-h-0 overflow-hidden w-full text-left appearance-none bg-transparent"
          onClick={handleClick}
        >
          <div className="flex-1 flex items-center justify-center min-h-0">
            <video
              src={shot.videoUrl}
              poster={shot.thumbnailUrl ?? undefined}
              className="max-w-full max-h-full object-contain rounded-md"
              muted
              loop
              playsInline
              onMouseEnter={(e) => void e.currentTarget.play()}
              onMouseLeave={(e) => {
                e.currentTarget.pause();
                e.currentTarget.currentTime = 0;
              }}
            />
          </div>
        </button>
        <EvalCellDialog
          open={dialogOpen}
          onOpenChange={onDialogOpenChange}
          shot={shot}
          sceneNumber={sceneNumber}
          sequenceTitle={sequenceTitle}
          aspectRatio={aspectRatio}
          initialTab={initialTab}
          onNavigateLeft={onNavigateLeft}
          onNavigateRight={onNavigateRight}
          onNavigateUp={onNavigateUp}
          onNavigateDown={onNavigateDown}
        />
      </>
    );
  }

  // Prompts view (default) — shows both visual and motion prompts
  if (!prompt && !motionPrompt) {
    return (
      <div className="border-b p-2 h-full flex items-center justify-center">
        <div className="text-xs text-muted-foreground">No prompts</div>
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        className="border-b p-2 cursor-pointer hover:bg-muted/50 transition-colors h-full flex flex-col min-h-0 w-full text-left appearance-none bg-transparent"
        onClick={handleClick}
      >
        <ScrollArea className="flex-1 w-full min-h-0">
          {prompt && (
            <p className="text-xs leading-relaxed whitespace-pre-wrap pr-2">
              {prompt}
            </p>
          )}
          {prompt && motionPrompt && <hr className="my-1.5 border-muted" />}
          {motionPrompt && (
            <p className="text-xs leading-relaxed whitespace-pre-wrap pr-2 text-muted-foreground">
              {motionPrompt}
            </p>
          )}
        </ScrollArea>
      </button>
      <EvalCellDialog
        open={dialogOpen}
        onOpenChange={onDialogOpenChange}
        shot={shot}
        sceneNumber={sceneNumber}
        sequenceTitle={sequenceTitle}
        aspectRatio={aspectRatio}
        initialTab={initialTab}
        onNavigateLeft={onNavigateLeft}
        onNavigateRight={onNavigateRight}
        onNavigateUp={onNavigateUp}
        onNavigateDown={onNavigateDown}
      />
    </>
  );
};
