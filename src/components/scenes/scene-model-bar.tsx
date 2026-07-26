import { type ModelGenerationStatus } from '@/components/model/base-model-selector';
import { ImageModelSelector } from '@/components/model/image-model-selector';
import { MotionModelSelector } from '@/components/model/motion-model-selector';
import { Kbd } from '@/components/ui/kbd';
import {
  safeImageToVideoModel,
  safeTextToImageModel,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import type { SelectionScope } from '@/lib/scenes/scene-selection';
import { useMemo } from 'react';

const MIXED = 'mixed' as const;
type ImageModelValue = TextToImageModel | typeof MIXED;
type VideoModelValue = ImageToVideoModel | typeof MIXED;

type SceneModelBarProps = {
  scope: SelectionScope;
  resolvedSequenceImageModel: TextToImageModel;
  resolvedSequenceVideoModel: ImageToVideoModel;
  /**
   * The model each in-scope shot's selected image / video version was rendered
   * with (#1066) — `null` where nothing is selected yet. One distinct value
   * shows as that model; more than one shows as "Mixed".
   */
  scopedImageModels: Array<string | null>;
  scopedVideoModels: Array<string | null>;
  imageModelStatuses?: Map<string, ModelGenerationStatus>;
  videoModelStatuses?: Map<string, ModelGenerationStatus>;
  onSequenceImageModelChange?: (model: TextToImageModel) => void;
  onSequenceVideoModelChange?: (model: ImageToVideoModel) => void;
  /** Pick the model the next generation runs with, at scene / shot scope. */
  onAssetImageModelChange?: (model: TextToImageModel) => void;
  onAssetVideoModelChange?: (model: ImageToVideoModel) => void;
  styleName?: string;
  recommendedImageModel?: string | null;
  recommendedVideoModel?: string | null;
  isUpdating?: boolean;
};

function resolveScopedImageModel(
  scope: SelectionScope,
  resolvedSequenceImageModel: TextToImageModel,
  scopedImageModels: Array<string | null>
): ImageModelValue {
  if (scope === 'sequence' || scopedImageModels.length === 0) {
    return resolvedSequenceImageModel;
  }
  const models = new Set(
    scopedImageModels.map((m) =>
      safeTextToImageModel(m, resolvedSequenceImageModel)
    )
  );
  const [only] = [...models];
  return models.size === 1 && only !== undefined ? only : MIXED;
}

function resolveScopedVideoModel(
  scope: SelectionScope,
  resolvedSequenceVideoModel: ImageToVideoModel,
  scopedVideoModels: Array<string | null>
): VideoModelValue {
  if (scope === 'sequence' || scopedVideoModels.length === 0) {
    return resolvedSequenceVideoModel;
  }
  const models = new Set(
    scopedVideoModels.map((m) =>
      safeImageToVideoModel(m, resolvedSequenceVideoModel)
    )
  );
  const [only] = [...models];
  return models.size === 1 && only !== undefined ? only : MIXED;
}

const scopeLabel: Record<SelectionScope, string> = {
  sequence: 'Sequence default',
  scenes: 'Scene assets',
  shot: 'Shot assets',
};

export const SceneModelBar: React.FC<SceneModelBarProps> = ({
  scope,
  resolvedSequenceImageModel,
  resolvedSequenceVideoModel,
  scopedImageModels,
  scopedVideoModels,
  imageModelStatuses,
  videoModelStatuses,
  onSequenceImageModelChange,
  onSequenceVideoModelChange,
  onAssetImageModelChange,
  onAssetVideoModelChange,
  styleName,
  recommendedImageModel,
  recommendedVideoModel,
  isUpdating = false,
}) => {
  const lookModel = useMemo(
    () =>
      resolveScopedImageModel(
        scope,
        resolvedSequenceImageModel,
        scopedImageModels
      ),
    [scope, resolvedSequenceImageModel, scopedImageModels]
  );

  const motionModel = useMemo(
    () =>
      resolveScopedVideoModel(
        scope,
        resolvedSequenceVideoModel,
        scopedVideoModels
      ),
    [scope, resolvedSequenceVideoModel, scopedVideoModels]
  );

  const isMixed = lookModel === MIXED || motionModel === MIXED;

  // At sequence scope a pick rewrites the sequence default; at scene / shot
  // scope it's a per-asset pick for the next generation (#1066).
  const handleLookChange = (model: TextToImageModel) => {
    if (scope === 'sequence') {
      onSequenceImageModelChange?.(model);
      return;
    }
    onAssetImageModelChange?.(model);
  };

  const handleMotionChange = (model: ImageToVideoModel) => {
    if (scope === 'sequence') {
      onSequenceVideoModelChange?.(model);
      return;
    }
    onAssetVideoModelChange?.(model);
  };

  return (
    <div className="space-y-3 border-b px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {scopeLabel[scope]}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {isMixed && scope === 'scenes' && (
            <span className="text-xs text-amber-600 dark:text-amber-400">
              Mixed — pick a model to apply to all
            </span>
          )}
          {/* Scope zoom-out affordance — same as the original scope breadcrumb
              (#986 / 2fa6ee75): Esc walks shot → scene → sequence. */}
          {scope !== 'sequence' && (
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <Kbd>esc</Kbd> up
            </span>
          )}
        </div>
      </div>
      <>
        <div className="space-y-2">
          <span className="text-sm font-medium">Image</span>
          {lookModel === MIXED ? (
            <ImageModelSelector
              selectedModel={resolvedSequenceImageModel}
              onModelChange={handleLookChange}
              disabled={isUpdating}
              recommendedImageModel={recommendedImageModel}
              styleName={styleName}
              generatedStatuses={imageModelStatuses}
            />
          ) : (
            <ImageModelSelector
              selectedModel={lookModel}
              onModelChange={handleLookChange}
              disabled={isUpdating}
              recommendedImageModel={recommendedImageModel}
              styleName={styleName}
              generatedStatuses={imageModelStatuses}
            />
          )}
        </div>
        <div className="space-y-2">
          <span className="text-sm font-medium">Video</span>
          {motionModel === MIXED ? (
            <MotionModelSelector
              selectedModel={resolvedSequenceVideoModel}
              onModelChange={handleMotionChange}
              disabled={isUpdating}
              recommendedVideoModel={recommendedVideoModel}
              styleName={styleName}
              generatedStatuses={videoModelStatuses}
            />
          ) : (
            <MotionModelSelector
              selectedModel={motionModel}
              onModelChange={handleMotionChange}
              disabled={isUpdating}
              recommendedVideoModel={recommendedVideoModel}
              styleName={styleName}
              generatedStatuses={videoModelStatuses}
            />
          )}
        </div>
      </>
    </div>
  );
};
